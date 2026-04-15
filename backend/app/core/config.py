"""Application configuration using Pydantic Settings."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Environment
    environment: str = "development"

    # Azure AD
    azure_ad_tenant_id: str = ""
    azure_ad_client_id: str = ""
    azure_ad_client_secret: str = ""

    # Azure Blob Storage
    azure_storage_connection_string: str = ""
    azure_storage_container_name: str = "meeting-audio"

    # Database (SQLite default for dev, PostgreSQL for production)
    database_url: str = "sqlite+aiosqlite:///./data/meetings.db"

    # Legacy Celery/Redis compatibility
    redis_url: str = "redis://localhost:6379/0"

    # Packaged backend runtime settings
    backend_host: str = "127.0.0.1"
    backend_port: int = 38741
    ffmpeg_path: str = ""

    # Storage backend: "local" (default), "minio", or auto-detect Azure
    storage_backend: str = "local"
    local_storage_dir: str = ""  # defaults to ./data/audio

    # MinIO (only needed if storage_backend=minio)
    minio_endpoint: str = "http://localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    # AssemblyAI (transcription + diarisation)
    assemblyai_api_key: str = ""

    # HuggingFace (legacy, kept for reference)
    hf_token: str = ""

    # Whisper (legacy, kept for reference)
    whisper_model: str = "medium"

    # Dev auth bypass
    use_dev_auth_bypass: bool = False

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",  # Ignore unrelated legacy env vars.
    )


settings = Settings()
