"""Regression tests for Windows install.ps1 dependency branch handling.

These assertions lock in the critical control-flow paths needed for native
Windows CLI + TUI installs:
- Node.js install via winget, with managed ZIP fallback
- npm invocation that avoids execution-policy failures on npm.ps1
- Python dependency fallback chain for Windows CLI/TUI
- Managed Node PATH/HERMES_NODE persistence across terminal sessions
"""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"


def test_node_install_keeps_winget_and_zip_fallback_paths() -> None:
    text = INSTALL_PS1.read_text()

    # Primary path: modern Windows machines with winget.
    assert "if (Get-Command winget -ErrorAction SilentlyContinue)" in text
    assert "winget install OpenJS.NodeJS.LTS" in text

    # Fallback path: no winget / winget failure => managed ZIP install.
    assert 'Write-Info "Downloading Node.js $NodeVersion binary..."' in text
    assert 'Move-Item $extractedDir.FullName "$HermesHome\\node"' in text
    assert '& "$HermesHome\\node\\node.exe" --version' in text


def test_system_packages_keep_winget_choco_scoop_fallback_chain() -> None:
    text = INSTALL_PS1.read_text()

    assert "$hasWinget = Get-Command winget -ErrorAction SilentlyContinue" in text
    assert "$hasChoco = Get-Command choco -ErrorAction SilentlyContinue" in text
    assert "$hasScoop = Get-Command scoop -ErrorAction SilentlyContinue" in text
    assert "if ($hasWinget)" in text
    assert "if ($hasChoco -and ($needRipgrep -or $needFfmpeg))" in text
    assert "if ($hasScoop -and ($needRipgrep -or $needFfmpeg))" in text


def test_npm_resolution_avoids_powershell_policy_blocks() -> None:
    text = INSTALL_PS1.read_text()

    # Prefer npm.cmd and convert npm.ps1 -> npm.cmd when needed.
    assert "function Resolve-NpmInvocation" in text
    assert "Get-Command npm.cmd -ErrorAction SilentlyContinue" in text
    assert '[System.IO.Path]::ChangeExtension($npm.Source, ".cmd")' in text

    # Last-resort path should still work by launching npm-cli.js via node.
    assert "node_modules\\npm\\bin\\npm-cli.js" in text
    assert "Invoke-NpmInstallSilent -WorkingDir $InstallDir" in text
    assert "Invoke-NpmInstallSilent -WorkingDir $tuiDir" in text


def test_python_dependency_install_has_windows_cli_tui_fallback() -> None:
    text = INSTALL_PS1.read_text()

    # Keep broad install attempt first.
    assert '& $UvCmd pip install -e ".[all]"' in text
    # Then fallback to Windows CLI/TUI essentials if optional extras fail.
    assert '& $UvCmd pip install -e ".[pty,mcp,honcho,acp]"' in text
    # Final safety fallback to base package.
    assert '& $UvCmd pip install -e "."' in text
    assert 'throw "Failed to install Hermes Python dependencies."' in text


def test_managed_node_is_persisted_for_future_tui_runs() -> None:
    text = INSTALL_PS1.read_text()

    assert "Add-UserPathEntry -CurrentPath $newPath -Entry $managedNodeDir" in text
    assert '[Environment]::SetEnvironmentVariable("HERMES_NODE", $managedNodeExe, "User")' in text
    assert '$env:Path = Add-UserPathEntry -CurrentPath $env:Path -Entry "$HermesHome\\node"' in text

