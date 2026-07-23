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
    data_dir: str = ""  # When set, all data paths derive from here (packaged builds)

    # Cloud resource endpoints (placeholders until provisioning).
    blob_account_url: str = ""
    postgres_dsn: str = ""
    key_vault_url: str = ""
    # OpenAI / Azure OpenAI (summaries + action items).
    openai_api_key: str = ""  # direct OpenAI API key (sk-...)
    openai_endpoint: str = ""
    openai_deployment: str = ""

    # PyannoteAI transcription + voiceprint identification per Jira IN-64/IN-69.
    similarity_threshold: float = 0.62
    # IN-79: approved key people for controlled second-pass voiceprint expansion.
    # Comma-separated employee ids/emails, e.g. "df@factor1.com.au,tc@factor1.com.au".
    voiceprint_expansion_employee_ids: str = ""
    voiceprint_expansion_cap: int = 5
    voiceprint_expansion_min_confidence: float = 0.85
    pyannote_api_key: str = ""
    pyannote_api_endpoint: str = "https://api.pyannote.ai"
    pyannote_model_version: str = "precision-2"
    pyannote_transcription_model: str = ""
    pyannote_transcription_language: str = ""
    pyannote_poll_interval_seconds: int = 10
    pyannote_poll_timeout_seconds: int = 1800
    # Optional diarization speaker-count hint (IN-86). 0 = let pyannote decide
    # (default). Set to a known speaker count to improve separation on hard
    # audio (e.g. a pre-mixed Teams downlink). Deliberately NOT auto-derived
    # from Graph attendees: attendees != speakers, and a silent recorder mic
    # means the attendee count over-estimates the audible speakers.
    pyannote_num_speakers: int = 0
    pyannote_hf_token: str = ""  # legacy/dev only; not the Slice 1 pyannoteAI API credential

    # SharePoint transcript delivery. Empty values use the local locked-folder stand-in.
    sharepoint_drive_id: str = ""
    sharepoint_folder_path: str = "Notetaker Transcripts"

    # Raw-audio retention (requirements §6.2 engineering default).
    audio_retention_days: int = 30

    # IN-471 Storage API (Slice 2). Empty = stub mode AND central enrolment
    # not yet required (config-flagged cutover). MN_STORAGE_API_SCOPE is also
    # read by the Electron main process for MSAL token acquisition — both
    # processes must see these MN_* variables.
    storage_api_url: str = ""
    storage_api_scope: str = ""
    storage_api_enabled: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
