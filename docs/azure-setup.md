# Cloud setup — plug-and-play checklist

Everything in the app runs today against local stand-ins. Each real resource
below replaces its stand-in by setting environment variables — no code changes.
Provider factories check config at call time and switch automatically.

## 1. Entra ID app registration (auth + Graph)

Portal → Entra ID → App registrations → New registration:

- Name: `Meeting Notetaker`
- Supported accounts: single tenant (Factor1)
- Redirect URI: `Mobile and desktop applications` → `http://localhost`
- API permissions (delegated): `User.Read`, `Calendars.Read`, `Mail.Send`
  (admin consent for the tenant)

Set public-client desktop config for the Electron main process:

- `MN_ENTRA_TENANT_ID=<Tenant ID>`
- `MN_ENTRA_CLIENT_ID=<Client ID>`

These IDs are public-client configuration, not secrets. Do not add a client
secret to the desktop app. Decide the authorised-users mechanism (security group
membership — open item in requirements §10).

## 2. Resource group + storage

- Resource group: `rg-meeting-notetaker` (region close to PH)
- Storage account → container `audio` with a **30-day delete lifecycle rule**,
  container `updates` (public read or SAS) for the installer feed
- Set `MN_BLOB_ACCOUNT_URL` → replaces `backend/var/audio`
- Put the `updates` container URL into `electron-builder.yml` `publish.url`

## 3. PostgreSQL

- Azure Database for PostgreSQL Flexible Server (enable `pgvector` extension
  for voiceprints if used later)
- Set `MN_POSTGRES_DSN` → triggers the SQLAlchemy repository build, replacing
  `backend/var/store.json` (schema is requirements §6.1; data migration is a
  one-off import of the snapshot)

## 4. Key Vault

- Standard tier; store: voiceprint encryption key, Graph client secret,
  Postgres password
- Set `MN_KEY_VAULT_URL` → also flips email from stub to Graph provider

## 5. PyannoteAI

Jira CSV is the source of truth for Slice 1. IN-64/IN-69 call for PyannoteAI
transcription and voiceprint identification.

- PyannoteAI account/API access for transcription + speaker ID
- Set `MN_PYANNOTE_API_KEY` to the pyannoteAI API key from the pyannoteAI dashboard
- Optional: set `MN_PYANNOTE_API_ENDPOINT` only for a tenant-specific pyannoteAI base URL; default is `https://api.pyannote.ai`
- Optional: set `MN_PYANNOTE_TRANSCRIPTION_MODEL` / `MN_PYANNOTE_TRANSCRIPTION_LANGUAGE` for pyannoteAI STT orchestration tuning

## 6. OpenAI (summaries + action items)

The LLM provider supports both Azure OpenAI and direct OpenAI API keys.
Set one or the other; the factory picks the first available.

- **Option A — Direct OpenAI key:** Set `MN_OPENAI_API_KEY` → activates
  `OpenAIProvider` against `api.openai.com`. No Azure provisioning needed.
- **Option B — Azure OpenAI:** Provision an Azure OpenAI resource + chat
  deployment (e.g. `gpt-4o`). Set `MN_OPENAI_ENDPOINT` and
  `MN_OPENAI_DEPLOYMENT` → activates `AzureOpenAIProvider`.

If neither is set, `StubLLMProvider` returns deterministic placeholder output.

## 7. Code signing + releases

- OV certificate or Azure Trusted Signing (procurement decision, §10)
- GitHub repo secrets: `CSC_LINK`, `CSC_KEY_PASSWORD` (or Trusted Signing
  config), `AZURE_STORAGE_CONNECTION_STRING`
- Uncomment the publish step in `.github/workflows/release.yml`; tag `vX.Y.Z`
  to ship. Clients auto-update from the Blob feed on restart (decision #12).

## Stub → real map

| Stand-in today | Real resource | Switch |
|---|---|---|
| `backend/var/audio` files | Blob Storage `audio` container | `MN_BLOB_ACCOUNT_URL` |
| `backend/var/store.json` | PostgreSQL | `MN_POSTGRES_DSN` |
| `StubSpeechProvider` | pyannoteAI transcription/speaker ID | `MN_PYANNOTE_API_KEY` |
| `StubLLMProvider` | OpenAI (direct or Azure) | `MN_OPENAI_API_KEY` or `MN_OPENAI_ENDPOINT` + `MN_OPENAI_DEPLOYMENT` |
| `StubEmailProvider` (logs) | Graph sendMail | `MN_KEY_VAULT_URL` |
| Dev sign-in stub | Entra ID via MSAL | tenant + client ID (main process) |
| Display-name actor header | Entra token subject | with MSAL wiring |
| Unidentified speaker fallback | pyannoteAI voiceprint identification | voiceprints + `MN_PYANNOTE_API_KEY` |
