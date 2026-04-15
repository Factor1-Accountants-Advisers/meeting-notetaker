from app.core.config import Settings


def test_settings_exposes_legacy_redis_url_with_safe_default(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    settings = Settings(_env_file=None)

    assert settings.redis_url == "redis://localhost:6379/0"


def test_settings_uses_redis_url_from_environment(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://example.com:6380/1")
    settings = Settings(_env_file=None)

    assert settings.redis_url == "redis://example.com:6380/1"
