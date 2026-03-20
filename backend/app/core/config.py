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

    # Database
    database_url: str = "postgresql+asyncpg://meetings_user:meetings_password@postgres:5432/meetings_db"

    # Redis
    redis_url: str = "redis://redis:6379/0"

    # MinIO (local development)
    minio_endpoint: str = "http://minio:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"

    # Anthropic
    anthropic_api_key: str = ""

    # HuggingFace
    hf_token: str = ""

    # Whisper
    whisper_model: str = "medium"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False
    )


settings = Settings()
