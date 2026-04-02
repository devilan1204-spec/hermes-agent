"""SSH remote execution environment with ControlMaster connection persistence."""

import logging
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

from tools.environments.base import BaseEnvironment

logger = logging.getLogger(__name__)


def _ensure_ssh_available() -> None:
    """Fail fast with a clear error when the SSH client is unavailable."""
    if not shutil.which("ssh"):
        raise RuntimeError(
            "SSH is not installed or not in PATH. Install OpenSSH client: apt install openssh-client"
        )


class SSHEnvironment(BaseEnvironment):
    """Run commands on a remote machine over SSH.

    Uses SSH ControlMaster for connection persistence so subsequent
    commands are fast. Security benefit: the agent cannot modify its
    own code since execution happens on a separate machine.

    Foreground commands are interruptible: the local ssh process is killed
    and a remote kill is attempted over the ControlMaster socket.

    Uses the unified spawn-per-call model:
    - bash -l once at session start to capture env snapshot on the remote
    - bash -c for every subsequent command (fast, no shell init overhead)
    - CWD tracked via cwdfile written after each command on the remote host
    """

    def __init__(self, host: str, user: str, cwd: str = "~",
                 timeout: int = 60, port: int = 22, key_path: str = "",
                 **kwargs):
        super().__init__(cwd=cwd, timeout=timeout)
        self.host = host
        self.user = user
        self.port = port
        self.key_path = key_path

        self.control_dir = Path(tempfile.gettempdir()) / "hermes-ssh"
        self.control_dir.mkdir(parents=True, exist_ok=True)
        self.control_socket = self.control_dir / f"{user}@{host}:{port}.sock"

        # Sync caches — skip rsync when local files haven't changed.
        self._synced_files: dict[str, tuple] = {}    # remote_path → (mtime, size)
        self._skills_fingerprint: set | None = None   # {(relpath, mtime, size), ...}
        self._created_remote_dirs: set[str] = set()

        _ensure_ssh_available()
        self._establish_connection()
        self._remote_home = self._detect_remote_home()
        self._sync_skills_and_credentials()
        self.init_session()

    def _build_ssh_command(self, extra_args: list | None = None) -> list:
        cmd = ["ssh"]
        cmd.extend(["-o", f"ControlPath={self.control_socket}"])
        cmd.extend(["-o", "ControlMaster=auto"])
        cmd.extend(["-o", "ControlPersist=300"])
        cmd.extend(["-o", "BatchMode=yes"])
        cmd.extend(["-o", "StrictHostKeyChecking=accept-new"])
        cmd.extend(["-o", "ConnectTimeout=10"])
        if self.port != 22:
            cmd.extend(["-p", str(self.port)])
        if self.key_path:
            cmd.extend(["-i", self.key_path])
        if extra_args:
            cmd.extend(extra_args)
        cmd.append(f"{self.user}@{self.host}")
        return cmd

    def _establish_connection(self):
        cmd = self._build_ssh_command()
        cmd.append("echo 'SSH connection established'")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if result.returncode != 0:
                error_msg = result.stderr.strip() or result.stdout.strip()
                raise RuntimeError(f"SSH connection failed: {error_msg}")
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"SSH connection to {self.user}@{self.host} timed out")

    def _detect_remote_home(self) -> str:
        """Detect the remote user's home directory."""
        try:
            cmd = self._build_ssh_command()
            cmd.append("echo $HOME")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            home = result.stdout.strip()
            if home and result.returncode == 0:
                logger.debug("SSH: remote home = %s", home)
                return home
        except Exception:
            pass
        # Fallback: guess from username
        if self.user == "root":
            return "/root"
        return f"/home/{self.user}"

    def _sync_skills_and_credentials(self, *, force: bool = False) -> None:
        """Rsync skills directory and credential files to the remote host.

        Uses local mtime+size caching to skip rsync when nothing changed.
        Pass force=True to bypass the cache (e.g. for debugging).
        """
        try:
            container_base = f"{self._remote_home}/.hermes"
            from tools.credential_files import get_credential_file_mounts, get_skills_directory_mount

            rsync_base = ["rsync", "-az", "--timeout=30", "--safe-links"]
            ssh_opts = f"ssh -o ControlPath={self.control_socket} -o ControlMaster=auto"
            if self.port != 22:
                ssh_opts += f" -p {self.port}"
            if self.key_path:
                ssh_opts += f" -i {self.key_path}"
            rsync_base.extend(["-e", ssh_opts])
            dest_prefix = f"{self.user}@{self.host}"

            # --- Credential files: per-file mtime check ---
            cred_to_sync = []
            for mount_entry in get_credential_file_mounts():
                hp = Path(mount_entry["host_path"])
                remote_path = mount_entry["container_path"].replace(
                    "/root/.hermes", container_base, 1
                )
                try:
                    s = hp.stat()
                    key = (s.st_mtime, s.st_size)
                except FileNotFoundError:
                    continue
                if not force and self._synced_files.get(remote_path) == key:
                    continue
                cred_to_sync.append((mount_entry["host_path"], remote_path, key))

            # Ensure remote directories exist for any new credential paths.
            # container_base is always included so skills rsync has its parent.
            needed_dirs = {container_base}
            for _, remote_path, _ in cred_to_sync:
                needed_dirs.add(str(Path(remote_path).parent))
            new_dirs = needed_dirs - self._created_remote_dirs
            if new_dirs:
                mkdir_cmd = self._build_ssh_command()
                mkdir_cmd.append(f"mkdir -p {' '.join(shlex.quote(d) for d in new_dirs)}")
                subprocess.run(mkdir_cmd, capture_output=True, text=True, timeout=10)
                self._created_remote_dirs |= new_dirs

            # Rsync changed credential files
            for host_path, remote_path, key in cred_to_sync:
                cmd = rsync_base + [host_path, f"{dest_prefix}:{remote_path}"]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                if result.returncode == 0:
                    self._synced_files[remote_path] = key
                    logger.info("SSH: synced credential %s -> %s", host_path, remote_path)
                else:
                    self._invalidate_sync_cache()
                    logger.debug("SSH: rsync credential failed: %s", result.stderr.strip())

            # --- Skills directory: fingerprint check + --delete for pruning ---
            skills_mount = get_skills_directory_mount(container_base=container_base)
            if skills_mount and (force or self._skills_dir_changed(skills_mount["host_path"])):
                remote_path = skills_mount["container_path"]
                cmd = rsync_base + [
                    "--delete",
                    skills_mount["host_path"].rstrip("/") + "/",
                    f"{dest_prefix}:{remote_path}/",
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                if result.returncode == 0:
                    logger.info("SSH: synced skills dir %s -> %s",
                                skills_mount["host_path"], remote_path)
                else:
                    self._invalidate_sync_cache()
                    logger.debug("SSH: rsync skills dir failed: %s", result.stderr.strip())
        except Exception as e:
            logger.debug("SSH: could not sync skills/credentials: %s", e)

    def _skills_dir_changed(self, host_path: str) -> bool:
        """Return True if any file in the skills dir has changed since last sync."""
        root = Path(host_path)
        if not root.is_dir():
            return False
        current: set[tuple] = set()
        try:
            for f in root.rglob("*"):
                if f.is_file() and not f.is_symlink():
                    s = f.stat()
                    current.add((str(f.relative_to(root)), s.st_mtime, s.st_size))
        except OSError:
            return True
        if current == self._skills_fingerprint:
            return False
        self._skills_fingerprint = current
        return True

    def _invalidate_sync_cache(self) -> None:
        """Clear sync caches — call on rsync failure or reconnect."""
        self._synced_files.clear()
        self._skills_fingerprint = None
        self._created_remote_dirs.clear()

    # ------------------------------------------------------------------
    # Unified execution hooks
    # ------------------------------------------------------------------

    def _before_execute(self):
        """Incremental sync before each command so mid-session credential
        refreshes and skill updates are picked up."""
        self._sync_skills_and_credentials()

    def _run_bash(self, cmd_string, *, stdin_data=None):
        cmd = self._build_ssh_command()
        cmd.extend(["bash", "-c", shlex.quote(cmd_string)])
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            text=True,
        )
        if stdin_data:
            try:
                proc.stdin.write(stdin_data)
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        return proc

    def _run_bash_login(self, cmd_string):
        cmd = self._build_ssh_command()
        cmd.extend(["bash", "-l", "-c", shlex.quote(cmd_string)])
        return subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True,
        )

    def cleanup(self):
        # Clean up remote snapshot before closing ControlMaster
        if self._snapshot_path:
            paths = self._snapshot_path
            try:
                cmd = self._build_ssh_command()
                cmd.append(f"rm -f {paths}")
                subprocess.run(cmd, capture_output=True, timeout=5)
            except Exception:
                pass

        super().cleanup()
        if self.control_socket.exists():
            try:
                cmd = ["ssh", "-o", f"ControlPath={self.control_socket}",
                       "-O", "exit", f"{self.user}@{self.host}"]
                subprocess.run(cmd, capture_output=True, timeout=5)
            except (OSError, subprocess.SubprocessError):
                pass
            try:
                self.control_socket.unlink()
            except OSError:
                pass
