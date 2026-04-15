from app.core.config import Settings


def test_settings_reads_packaged_backend_runtime_env_vars(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./tmp/runtime.db")
    monkeypatch.setenv("LOCAL_STORAGE_DIR", "./tmp/audio")
    monkeypatch.setenv("FFMPEG_PATH", "C:/ffmpeg/bin/ffmpeg.exe")
    monkeypatch.setenv("BACKEND_HOST", "0.0.0.0")
    monkeypatch.setenv("BACKEND_PORT", "41234")

    settings = Settings(_env_file=None)

    assert settings.database_url == "sqlite:///./tmp/runtime.db"
    assert settings.local_storage_dir == "./tmp/audio"
    assert settings.ffmpeg_path == "C:/ffmpeg/bin/ffmpeg.exe"
    assert settings.backend_host == "0.0.0.0"
    assert settings.backend_port == 41234
