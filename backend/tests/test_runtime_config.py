from app.core.config import Settings


def test_settings_uses_packaged_backend_defaults(monkeypatch):
    monkeypatch.delenv("BACKEND_HOST", raising=False)
    monkeypatch.delenv("BACKEND_PORT", raising=False)
    monkeypatch.delenv("FFMPEG_PATH", raising=False)

    settings = Settings(_env_file=None)

    assert settings.backend_host == "127.0.0.1"
    assert settings.backend_port == 38741
    assert settings.ffmpeg_path == ""


def test_settings_reads_packaged_backend_runtime_env_vars(monkeypatch):
    monkeypatch.setenv("BACKEND_HOST", "0.0.0.0")
    monkeypatch.setenv("BACKEND_PORT", "41234")
    monkeypatch.setenv("FFMPEG_PATH", "C:/ffmpeg/bin/ffmpeg.exe")

    settings = Settings(_env_file=None)

    assert settings.backend_host == "0.0.0.0"
    assert settings.backend_port == 41234
    assert settings.ffmpeg_path == "C:/ffmpeg/bin/ffmpeg.exe"
