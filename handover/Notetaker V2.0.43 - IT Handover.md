# Notetaker IT Handover — Intune Deployment Guide

| | |
|---|---|
| Audience | IT / Infrastructure (deployment, identity, support) |
| Application version | 2.0.43 |
| Document date | 16 November 2026 |
| Prepared by | Innovations team (innovations@factor1.com.au) |
| Status | In production pilot, signed installer, Intune-deployed, self-updating. |

## Contents

1. What the system is
2. Technology and architecture
3. Identity and Microsoft 365 requirements
4. Installer and Intune deployment
5. Configuration and credentials
6. Machine footprint
7. Updates
8. IT runbook — supporting users
9. Open items before broad rollout
10. Contacts
11. Version history

## 1. What the system is

Meeting Notetaker is an internal Windows desktop application for Factor1 Accountants & Advisers. It records meetings (Teams calls and in-room conversations), transcribes them, identifies who spoke using centrally stored staff voiceprints, generates a summary with action items, emails the finished notes to all meeting attendees, and saves the transcript and summary to the SharePoint Transcriptions library with attendee view access granted automatically.

For Teams meetings the signed-in user organises, the app records automatically: it watches the user's Outlook calendar (5-minute poll) and starts recording about 1–2 minutes before/into the meeting start, stopping within a minute of the scheduled end (users can extend from a toast or the tray). Ad-hoc and in-room meetings are recorded manually.

The app runs in the system tray, starts at Windows sign-in by default, and is intended to be always-on for staff who host client meetings.

## 2. Technology and architecture

The installed product is two cooperating processes on the user's machine plus cloud services that do the heavy lifting:

| Component | Technology | What it does |
|---|---|---|
| Desktop client ("Meeting Notetaker.exe") | Electron + React + TypeScript | UI, audio capture (mic + system loopback), Microsoft sign-in, calendar polling, tray/startup behaviour. Never talks to the internet except Microsoft identity/Graph and the update feed. |
| Local backend ("notetaker-backend.exe") | Python + FastAPI (PyInstaller bundle, ships inside the installer) | The only component that touches data. Stores meetings, runs the processing pipeline, calls the cloud AI providers. Listens on 127.0.0.1:8787 (localhost only). |
| Central Storage API (cloud) | Azure Functions app behind Entra ID (delegated auth) | System of record for staff voiceprints and meeting records. Voiceprints are no longer stored per machine, enrol once, recognised everywhere. |
| pyannoteAI (cloud) | SaaS API (api.pyannote.ai) | Transcription, speaker separation and voiceprint speaker identification. |
| OpenAI (cloud) | SaaS API (api.openai.com) | Meeting summary and action-item extraction from the transcript. |
| Microsoft Graph (cloud) | Delegated permissions via Entra ID | Calendar meeting detection, transcript email (Mail.Send), SharePoint file save. |

### 2.1 How the pieces fit together

- The Electron app spawns and supervises notetaker-backend.exe on launch (packaged builds only), health-checking `http://127.0.0.1:8787/health`.
- If a healthy backend of the same app version is already listening on 8787, the app adopts it instead of spawning a duplicate (version handshake via /health). The installer and uninstaller kill any orphaned notetaker-backend.exe automatically — the 2.0.6 "uninstall blocked by a running process" issue is fixed.
- If the backend crashes it is restarted automatically with backoff; after repeated failures the user sees a "Backend Unavailable" dialog pointing at the log file.
- A single-instance lock prevents two copies of the app running for the same user.
- All AI providers sit behind interfaces with built-in stubs: if an API key is missing the app still runs but produces placeholder output. CI fails the release build if any key or Storage API setting is missing, so a stub installer cannot ship by accident. (section 5).
- The backend connects to the central Storage API with a short connection budget per network address. On a network where the IPv6 route to the Storage API is unusable, the backend moves to IPv4 within 3 seconds. A voiceprint check answers within 10 seconds, including when the Storage API is unreachable.

### 2.2 Processes visible in Task Manager

| Process | Notes |
|---|---|
| Meeting Notetaker.exe | Electron main process plus the usual Electron helper/GPU child processes. |
| notetaker-backend.exe | The bundled FastAPI backend. Spawned hidden (no console window). One per user session. |
| notetaker-audio-endpoints.exe | Audio device monitor started by the app. It lets a recording follow headset and device switches. Ships under `resources\audio`. |

## 3. Identity and Microsoft 365 requirements

The app signs users in with their Factor1 Microsoft account using an Entra ID public-client app registration (authorisation-code flow with PKCE; the sign-in happens in the user's default browser). No client secret is stored on the device.

| Setting | Value |
|---|---|
| Entra application (client) ID | 3e3f3422-d4fa-4ebe-9b22-148439e84cc3 |
| Tenant ID | 891d380b-39a6-4eb4-aca5-4ffe1d3c25ac (single tenant) |
| Platform / redirect URI | Mobile & desktop applications — http://localhost (loopback redirect) |
| Token cache | `%APPDATA%\meeting-notetaker\auth\msal-cache.bin`, encrypted with Windows DPAPI for the signed-in Windows user (since v2.0.8). The app clears a cache it cannot decrypt and shows the sign-in screen. **Sign out** clears the cache. |
| Access control | Access is governed by the "Notetaker Users" security group in Azure (IT-owned). The same group drives Intune app assignment and the trust-certificate deployment (section 4). This closes the Slice 1 gap where any tenant user with the installer could sign in. |

### 3.1 Delegated Graph permissions

Grant tenant-wide admin consent for the following delegated scopes on the app registration before rollout, so users are not blocked by per-user consent prompts:

| Scope | Used for |
|---|---|
| User.Read | Basic profile at sign-in. |
| Calendars.Read | Polling /me/calendarView every 5 minutes to detect meetings for auto-recording. |
| Mail.Send | Emailing the finished transcript from the user's own mailbox. |
| Files.ReadWrite.All | Saving transcript + summary to the SharePoint Transcriptions library and granting attendees view access. High-privilege scope — admin consent granted. |

The backend additionally requests a delegated token for the central Storage API (`api://13298042-714a-4d57-a1c5-481c22753087/access_as_user`) using the same signed-in account. Notetaker checks the user's voiceprint with this token before the Home screen opens.

## 4. Installer and Intune deployment

### 4.1 The installer

| Property | Value |
|---|---|
| Artifact | Meeting Notetaker-&lt;version&gt;-setup.exe (NSIS) |
| App ID | com.factor1.notetaker |
| Install type | Per-user, one-click (no admin rights, no UAC prompt). Installs under %LOCALAPPDATA%\Programs. |
| Silent install | Meeting Notetaker-&lt;version&gt;-setup.exe /S |
| Shortcuts | Start Menu and Desktop (NSIS defaults). |
| Uninstall | Per-user uninstaller registered under HKCU. Uninstall deliberately leaves user data (recordings, voiceprints, meeting store) in place. |
| Signing | SIGNED. Every release is signed in CI via Azure Artifact Signing (Private Trust): subject CN=factor1.com.au, O=factor1.com.au, OU=IT Shared Services, with a Microsoft timestamp. Verify with Get-AuthenticodeSignature. |
| Trust chain | Private Trust chains to "Microsoft Enterprise Identity Verification Root Certificate Authority 2020" (thumbprint AB3FD6E553CCFF3E34C164623B70F30CE1937A74). IT pushes this root via an Intune Trusted-certificate profile to the Notetaker Users group (deployed 3 Aug 2026). Devices without the root see SmartScreen warnings on manual installs and reject auto-updates — expected on unmanaged/BYO machines, by design of Private Trust. |

### 4.2 Intune Win32 packaging (per DV-confirmed approach)

The confirmed direction (Jira IN-89) is to wrap the NSIS installer with the Microsoft Win32 Content Prep Tool and deploy it as a Win32 app. No .intunewin package has been produced yet — that step is scheduled after code signing. Recommended settings when packaging:

| Setting | Recommended value |
|---|---|
| Package source | Meeting Notetaker-&lt;version&gt;-setup.exe → IntuneWinAppUtil → .intunewin |
| Install command | "Meeting Notetaker-&lt;version&gt;-setup.exe" /S |
| Uninstall command | "%LOCALAPPDATA%\Programs\meeting-notetaker\Uninstall Meeting Notetaker.exe" /S |
| Install behaviour | User context (the installer is per-user; System context will not work as-is). |
| Detection rule | File exists: %LOCALAPPDATA%\Programs\meeting-notetaker\Meeting Notetaker.exe (or the HKCU uninstall registry key for com.factor1.notetaker), with version check for upgrades. |
| Requirements | Windows 11 64-bit (developed and tested on Windows 11; no server/ARM validation). |

Per the org App Deployment Guide: wrap the signed installer with the Microsoft Win32 Content Prep Tool (`IntuneWinAppUtil.exe -c <src> -s <setup.exe> -o <out>`) and deploy as a Win32 app, user context, assigned to the Notetaker Users group. Detection rule: %LOCALAPPDATA%\Programs\meeting-notetaker\Meeting Notetaker.exe (or the HKCU uninstall key for com.factor1.notetaker).

**IMPORTANT:** Intune deployment is needed once per machine, not once per release. After the first install the app keeps itself current from the update feed (section 7). Re-packaging for Intune is only needed if the minimum-supported installer version should move forward (e.g. for new machines).

### 4.3 How releases are built

- Pushing a git tag v* to the GitHub repository triggers the release workflow: it builds the Python backend bundle (PyInstaller + ffmpeg), smoke-tests it, injects the team API keys and Storage API settings from GitHub Actions secrets into backend.env inside the installer, signs the app binary and the setup exe via Azure Artifact Signing, asserts the signature/subject/timestamp, and publishes the installer, blockmap and feed manifest to the update feed in the same run.
- The build fails on purpose if any credential secret is missing, so a non-functional stub installer cannot ship by accident.

## 5. Configuration and credentials

### 5.1 How configuration is layered

1. Bundled defaults: the installer ships `resources\backend\backend.env` containing the spend-capped team API keys (OpenAI, pyannoteAI) and Storage API settings, injected from GitHub secrets at build time. Installs need no manual key setup. Note: this file is plaintext on disk — an accepted, documented risk for spend-capped keys (security triage 30 Jul 2026); Azure-managed key delivery remains a candidate for a later release.
2. Per-machine override: `C:\ProgramData\Factor1\MeetingNotetaker\backend.env` (KEY=VALUE lines). Any key present here wins over the bundled value. Retained as an emergency mechanism only — routine rotation no longer touches machines (see 5.2).

### 5.2 Rotating API keys

1. Update the MN_OPENAI_API_KEY / MN_PYANNOTE_API_KEY secrets in the GitHub repository.
2. Ship a patch release (tag v2.0.x). The fleet picks it up via auto-update, which replaces the bundled backend.env everywhere.
3. Only after the fleet is on the new version, revoke the old keys — installed machines carry the old key until they update.
4. pyannoteAI caution: staff voiceprints are associated with the pyannoteAI account. Rotating a key within the same account is safe; moving to a different account orphans all existing voiceprints and forces company-wide re-enrolment. Confirm account continuity before any pyannote change.

### 5.3 Key settings reference

All backend settings use the MN_ prefix. Everything is optional — missing keys switch that provider to a safe stub — but a functional deployment needs the two AI keys. The most operationally relevant settings:

| Variable | Purpose | Default when empty |
|---|---|---|
| MN_OPENAI_API_KEY | OpenAI key for summaries and action items | Stub (placeholder summaries) |
| MN_PYANNOTE_API_KEY | pyannoteAI key for transcription and speaker ID | Stub (no real transcript) |
| MN_STORAGE_API_URL / MN_STORAGE_API_SCOPE | Central Storage API endpoint and Entra scope (voiceprints, meeting records). Baked into packaged builds by CI. | Stub/local mode — enrolment gate cannot verify central enrolment |
| MN_BACKEND_PORT / MN_BACKEND_HOST | Backend bind address | 127.0.0.1:8787 |
| MN_DATA_DIR | Backend data root (set automatically by the app) | %APPDATA%\meeting-notetaker\backend-data |
| MN_AUDIO_RETENTION_DAYS | Days before raw audio is deleted | 30 |
| MN_SHAREPOINT_DRIVE_ID | Target SharePoint drive for transcripts | Local stand-in folder (not real SharePoint) |
| MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS | Extra staff (emails) matched on manual recordings | Only the recorder's own voiceprint is matched |
| MN_ENTRA_CLIENT_ID / MN_ENTRA_TENANT_ID | Override the built-in Entra app registration | Built-in Factor1 registration (section 3) |

## 6. Machine footprint

### 6.1 Files and folders

| Location | Contents |
|---|---|
| %LOCALAPPDATA%\Programs\meeting-notetaker\ | The application, including the backend bundle under resources\backend and the audio device monitor under resources\audio. |
| %APPDATA%\meeting-notetaker\backend-data\ | Local meeting store and working files. Survives app updates and uninstall. (Voiceprints now live centrally, not here.) |
| %APPDATA%\meeting-notetaker\recordings\ | Local copies of finished captures (safety net if upload fails). |
| %APPDATA%\meeting-notetaker\logs\ | main.log — the first thing to collect for any support ticket. The in-app "Report a problem" button (Settings) sends these to the Innovations inbox automatically. |
| %APPDATA%\meeting-notetaker\auth\msal-cache.bin | Microsoft token cache, encrypted with Windows DPAPI (lets sign-in survive restarts). A plaintext msal-cache.json from a version before 2.0.8 is converted on first launch, then deleted. |
| C:\ProgramData\Factor1\MeetingNotetaker\backend.env | Optional per-machine credential override (section 5). |

### 6.2 Registry

- Auto-start at sign-in: a per-user Run key at `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` launching the app with `--background` (starts hidden in the tray). Enabled by default on first launch of a packaged build; the user can turn it off in Settings → App.
- Standard per-user NSIS uninstall entries under HKCU.

### 6.3 Network (firewall / proxy allowlist)

All traffic is outbound HTTPS. The backend listens on localhost only and needs no inbound rules.

| Endpoint | From | Purpose |
|---|---|---|
| login.microsoftonline.com | Meeting Notetaker.exe | Entra ID sign-in and token refresh |
| graph.microsoft.com | Both processes | Calendar polling, transcript email, SharePoint save |
| api.pyannote.ai | notetaker-backend.exe | Transcription and speaker identification |
| api.openai.com | notetaker-backend.exe | Summaries and action items |
| func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net | notetaker-backend.exe | Central Storage API (voiceprints, meeting records). Notetaker checks the user's voiceprint here before the Home screen opens. |
| stf1nt.blob.core.windows.net | Meeting Notetaker.exe | Auto-update feed (live) |
| http://localhost:&lt;random port&gt; | Default browser → app | OAuth loopback redirect during sign-in (local only) |

## 7. Updates

- The app self-updates from the feed at https://stf1nt.blob.core.windows.net/updates/ (electron-updater). It checks on every launch and every 4 hours while running; users can also check from Settings.
- When an update is downloaded, a toast offers "Restart now" / "Later". Updates never interrupt an active recording. Downloads are differential (blockmap), so they are small.
- Every update is signature-verified against the Private Trust chain before installing — machines must have the root certificate from section 4.1 (pushed via Intune). A machine without the root silently stays on its current version (log line in main.log); fix by confirming the device is in the Notetaker Users group and Intune has applied the certificate profile.
- A failed/unreachable feed never blocks the app from starting.

## 8. IT runbook — supporting users

### 8.1 Verifying a healthy install

1. Launch the app; it reaches the Home screen after Microsoft sign-in and a short "Checking your voiceprint" screen.
2. Settings → About must show the current release version (2.0.43 at the time of writing) — this also proves auto-update is working.
3. Hover the tray icon: the tooltip must read "Meeting Notetaker — Idle", not "Backend unavailable".
4. Check Task Manager for notetaker-backend.exe under the user's session.
5. Get-AuthenticodeSignature on the installed Meeting Notetaker.exe reports Valid with subject CN=factor1.com.au.
6. Record a ~30-second test meeting from Home; wait for the email confirmation and check the SharePoint Transcriptions library for the two files.

### 8.2 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| SmartScreen "Windows protected your PC" during install | Machine does not trust the Private Trust root (unmanaged/BYO device) | Expected off-fleet. On managed devices, confirm the Intune certificate profile applied (root thumbprint AB3FD6E553CCFF3E34C164623B70F30CE1937A74). More info → Run anyway is safe for pilot use. |
| App never updates / stuck on an old version | Missing Private Trust root, or device not in Notetaker Users group | Confirm group membership and the Intune certificate profile; then restart the app (update check runs on launch). |
| Tray tooltip "Backend unavailable" / every screen shows sample data | Backend failed to start or crashed repeatedly | Use the in-app Report a problem button, or collect %APPDATA%\meeting-notetaker\logs\backend.log. Quit via tray and relaunch — the supervisor restarts or adopts the backend. |
| App does not auto-record a meeting | User is not the meeting organiser, meeting is not a Teams online meeting, or the app is not running | Expected for non-organisers and in-person meetings (use manual recording). Otherwise confirm the app is in the tray and the user is signed in. |
| "Microphone appears silent" banner while recording | Mic muted at OS level, or the audio device genuinely produces silence | Since 2.0.13 the recording follows Bluetooth/device switches automatically, so a switch mid-meeting is no longer a failure. If the banner shows, check OS-level mute and the selected device in Settings → Audio capture. |
| **Sign in again** screen | The Microsoft sign-in on this computer has stopped working: the token cache is missing or could not be decrypted, or the sign-in has expired or been revoked. main.log shows `[auth] Storage API token unavailable { reason: 'no_cached_account' }` or `{ reason: 'interaction_required' }`. | The user clicks **Sign in again** and completes the Microsoft sign-in. The user keeps their voiceprint: do not re-enrol, reinstall or delete app data. If the screen returns after every restart, collect the logs with Report a problem. |
| **Sign in again** screen with the message "You're signed in, but Notetaker still can't reach the voiceprint service. Contact the IT service desk." | The Microsoft sign-in works, but Entra refuses a token for the Notetaker Storage API for this user: a Conditional Access policy on that resource, or removed consent for `access_as_user`. main.log shows `[auth] signed in, but the Storage API token is still unavailable`. | IT checks the user's Entra sign-in logs for the Notetaker Storage API resource, and the tenant-wide admin consent for `access_as_user` on the Notetaker app registration. Signing in again leaves this unchanged. |
| **Couldn't check your voiceprint** screen with **Try again** | The user is signed in, but the backend could not get an answer from the central Storage API (network, proxy or service outage). | Check that the machine reaches the Storage API host (section 6.3), then the user clicks **Try again**. Do not re-enrol. |
| **Voiceprint required** screen and the enrolment wizard | The central Storage API answered: this account has no voiceprint. | The user enrols. If the user enrolled before, check they signed in with their own Factor1 account. |
| Transcript email did not arrive | Outlook sign-in expired or Mail.Send consent missing | User clicks "Retry email" on the Home notice and completes the Outlook sign-in. Verify admin consent for Mail.Send. |
| Sign-in fails or loops | Token cache corruption or conditional-access interference | Quit the app from the tray, delete %APPDATA%\meeting-notetaker\auth\msal-cache.bin (and any leftover msal-cache.json), relaunch, sign in again. |
| Port 8787 already in use | Another process (or an orphaned backend) is listening | The app adopts an existing healthy backend automatically. If the listener is a foreign process, stop it — the port is fixed by design. |

### 8.3 Resetting and offboarding

- Full local reset: quit the app, delete %APPDATA%\meeting-notetaker\backend-data, relaunch. Central voiceprint enrolment is unaffected, the user will NOT need to re-enrol.
- Offboarding a user: uninstall the app, delete %APPDATA%\meeting-notetaker (and the ProgramData override if present), revoke Entra sign-in as usual, and ask Innovations (or use the Voiceprint Admin screen, admin role required) to disable the person's central voiceprint.
- Raw meeting audio deletes itself after 30 days; transcripts and summaries are retained (email + SharePoint are the system of record).

## 9. Open items before broad rollout

Slice 1 is code-complete and verified with the 4-person test team. These operational items are outstanding and mostly sit with IT / external owners:

| # | Item | Impact until done | Owner |
|---|---|---|---|
| 1 | Code-signing certificate for the installer | DONE (31 Jul 2026, IN-81). Azure Artifact Signing in CI; root cert pushed via Intune 3 Aug 2026. | IT / DV |
| 2 | Org-owned pyannoteAI account and spend-capped OpenAI key (currently personal/dev keys, spend-capped, bundled) | Keys rotated 4 Aug 2026 (v2.0.15) at IT's request; rotation now flows through GitHub secrets + patch release. Transfer of the AI accounts to org ownership is still being finalised (note the pyannote voiceprint-account caution in 5.2). | David / DV |
| 3 | Entra app is not restricted to specific user group but available tenant wide | CLOSED — access, Intune assignment and certificate deployment all run through the Notetaker Users security group (IT, 3 Aug 2026). | IT |

## 10. Contacts

| Topic | Contact |
|---|---|
| Application owner / escalations | IT (IN prior to handover) |
| Build pipeline, source code, releases | IN (GitHub: Factor1-Accountants-Advisers/meeting-notetaker) |
| Intune / identity / certificates | IT |
| Feature Requests | IN - Ideas portal |
| Jira project | IN — The Notetaker (epic IN-50, Slice 1 parent IN-64) |

## 11. Version history

| Version | Date | What changed | Changed by |
|---|---|---|---|
| V2.0.15 | 4 August 2026 | Previous published version. | Innovations team |
| V2.0.43 | 16 November 2026 | Section 8.2: four rows for the new screens (**Sign in again**, **Couldn't check your voiceprint**, **Voiceprint required**) replace the "asked to re-enrol" row; the "Sign-in fails or loops" row names the current token cache file. Sections 3 and 6.1: the token cache is `msal-cache.bin`, encrypted with Windows DPAPI. Section 2.1: the backend moves to IPv4 within 3 seconds when the IPv6 route to the Storage API is unusable. Section 2.2: the audio device monitor process. Cover and section 8.1: application version 2.0.43. | Innovations team |
