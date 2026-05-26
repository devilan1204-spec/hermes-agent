from pathlib import Path
import tomllib


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_faster_whisper_is_not_a_base_dependency():
    data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    deps = data["project"]["dependencies"]

    assert not any(dep.startswith("faster-whisper") for dep in deps)

    # faster-whisper now lives in the stt plugin, not the root voice extra
    stt_plugin = tomllib.loads((REPO_ROOT / "plugins/stt/pyproject.toml").read_text(encoding="utf-8"))
    stt_deps = stt_plugin["project"]["dependencies"]
    assert any(dep.startswith("faster-whisper") for dep in stt_deps)


def test_manifest_includes_bundled_skills():
    manifest = (REPO_ROOT / "MANIFEST.in").read_text(encoding="utf-8")

    assert "graft skills" in manifest
    assert "graft optional-skills" in manifest
