from app.core.config import Settings


def test_settings_exposes_legacy_redis_url_with_safe_default(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    settings = Settings(_env_file=None)

    assert settings.redis_url == "redis://localhost:6379/0"
