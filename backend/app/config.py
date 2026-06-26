from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Backend configuration.

    Values come from environment variables (prefix MN_) or a local .env file.
    Secrets are injected from Azure Key Vault in deployed environments — never
    committed to the repo (requirements §7).
    """

    model_config = SettingsConfigDict(env_prefix="MN_", env_file=".env", extra="ignore")

    environment: str = "dev"
    api_v1_prefix: str = "/api/v1"

    # Cloud resource endpoints (placeholders until provisioning).
    blob_account_url: str = ""
    postgres_dsn: str = ""
    key_vault_url: str = ""
    openai_endpoint: str = ""
    openai_deployment: str = ""

    # PyannoteAI transcription + voiceprint identification per Jira IN-64/IN-69.
    similarity_threshold: float = 0.62
    pyannote_api_endpoint: str = ""
    pyannote_model_version: str = "pyannote/embedding-3.1"
    pyannote_hf_token: str = ""  # HuggingFace/Pyannote token for API/model access

    # Raw-audio retention (requirements §6.2 engineering default).
    audio_retention_days: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()
