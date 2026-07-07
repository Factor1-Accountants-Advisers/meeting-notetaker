# Packaging readiness plan — Slice 1 test-team rollout

Date: 2026-07-06
Author: Joseph Guerrero (drafted with Claude Code)
Status: APPROVED 2026-07-07 — Phase 1 alignment review passed (all 10 evidence
references confirmed, zero locked-decision challenges, zero deviations).
Execution delegated to hermes agent. Amendments at approval:
 - D1: smaller-diff option locked (401 branch only; LocalSharePointProvider
   stays reachable only when drive id unconfigured).
 - A3: conftest_env.py approach locked (over per-module setUpModule).
 - B1-B3 split: hermes AUTHORS all B files from WSL (run_backend.py, .spec,
   find_ffmpeg(), smoke script); the PyInstaller BUILD + smoke EXECUTION are
   handed off to Windows-side Python or a release.yml CI job — report as
   "handed off", not "blocked".
Target: installable, unsigned-locally / CI-signed NSIS build that the 4-person
test team can run on plain Windows machines with no repo checkout, no venv,
and no manually started uvicorn.

## Context

Audit 2026-07-06 (see memory + `docs/jira-progress.md`): Slice 1 application
code is complete and committed through `31d711e`, but the agreed packaging
plan (IN-81) is 0% implemented and three honesty/security fixes should land
before any test-team install. This plan turns the audit findings into
executable workstreams.

**Evidence for current gaps (verified against `main` @ `31d711e`):**

| Gap | Evidence |
|---|---|
| No `MN_DATA_DIR` | zero matches in `backend/` |
| Repo-relative data paths | `store.py:89`, `services/pipeline.py:37`, `services/voiceprints.py:18`, `services/sharepoint.py:26` — all `Path(__file__).resolve().parents[...] / "var"` |
| Backend not shipped | `electron-builder.yml` `files: ['!backend/**']`, no `extraResources`, no PyInstaller spec |
| Nothing launches backend | `src/main/api-proxy.ts:9` assumes `http://127.0.0.1:8787`; no spawn anywhere in `src/main` |
| ffmpeg not bundled | `shutil.which("ffmpeg")` at `services/audio_checks.py:36` and `routers/meetings.py:157` (merge path 500s without it) |
| Update feed unset | `electron-builder.yml:34` `url: https://REPLACE_ME...` |
| SharePoint fake-"saved" | `services/sharepoint.py:110-112` falls back to `LocalSharePointProvider` (file:// URL shown as "saved to SharePoint") when Graph token missing |
| `email_notes` no ACL | `routers/meetings.py:293` — has `actor` param but never calls `require()` |
| OAuth `state` missing | `src/main/auth-msal.ts:167-172` `getAuthCodeUrl` sends no `state`; callback at `:318-336` accepts any request with a `code` |
| Test suite clobbers live store | `tests/test_delivery_reliability.py` writes the real `var/store.json` (caused the 2026-07-04 data-loss incident) |

## Goals / non-goals

**Goals**
1. Backend runs from an installed location with relocatable data (Workstream A).
2. Backend ships inside the installer as a PyInstaller onedir bundle with
   ffmpeg (Workstream B).
3. Electron spawns, supervises, and stops the backend (Workstream C).
4. Per-machine credentials load from a `%PROGRAMDATA%` env file (Workstream C4).
5. Trust/security fixes land before test-team exposure (Workstream D).
6. Installed-build verification checklist executed (Workstream F).

**Non-goals (explicitly out of scope for this plan)**
- P0 mic-silence root cause (BT hands-free / exclusive-mode suspicion). That
  is a **manual Windows hardware test Joseph runs in parallel** — different
  mic during a real Teams call. No code task here; guardrails already shipped
  in `31d711e`. Rollout decision depends on its outcome.
- Code-signing certificate, Blob update-feed provisioning, org-owned
  pyannote/OpenAI accounts (IN-82/IN-97) — external dependencies; tracked in
  Workstream E as blocked items, not executable tasks.
- `GET /audio` authentication (`routers/meetings.py:497`) — documented Slice 1
  stand-in, loopback-only exposure; deferred (note added to E).
- MSAL cache encryption (documented "Slice 1 stand-in" in `auth-msal.ts`).
- Postgres/Blob/Key Vault migration (later slices).

## Locked decisions (change here before execution, not mid-flight)

1. **Data dir default**: `MN_DATA_DIR` env var. When **unset**, behavior is
   byte-identical to today (repo-relative `backend/var/`) so the WSL dev loop
   and existing dev data are untouched. When set, all four path constants
   derive from it. Packaged apps pass
   `MN_DATA_DIR=<userData>\backend-data` (per-user, survives app updates,
   Electron `app.getPath('userData')`). Rationale: meetings/voiceprints are
   per-user on single-user machines; per-machine `%PROGRAMDATA%` data would
   need ACL work and none of the test team shares a machine. Voiceprint
   registry stays local per the 2026-07-03 team decision.
2. **Port**: keep fixed `8787` on `127.0.0.1`. The supervisor treats a
   pre-existing healthy listener as "backend already running" (dev
   coexistence) and surfaces a startup error otherwise. Dynamic ports would
   force `MN_API_BASE` injection into the renderer for marginal benefit.
3. **Credentials** (AMENDED 2026-07-07, exec-approved): dedicated team keys
   (spend-capped OpenAI + separate pyannote key) ARE bundled into the
   installer so installs need no manual key step. Mechanism: a local,
   untracked `backend.env` is copied into the backend bundle at package time
   (CI: written from GitHub Actions secrets); the supervisor loads bundled
   `resources/backend/backend.env` first, then merges
   `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env` ON TOP as the
   per-machine override — which is also the key-rotation path (drop an
   override file; no installer rebuild). Keys still NEVER enter the repo.
   Risk accepted by exec team; mitigations: internal-only distribution of
   the installer, spend caps, rotation via override file. AGENTS.md
   "desktop must not ship API keys" rule carries a documented exception
   scoped to these team keys.
   (Superseded original rationale: NSIS artifacts are extractable, so
   bundled keys are readable by anyone holding the setup exe.)
4. **Backend bundle format**: PyInstaller **onedir** (not onefile — onefile
   self-extracts to temp on every launch: slow start, AV-flag prone).
5. **ffmpeg discovery order**: bundled binary first (`MN_FFMPEG_PATH` env >
   sibling `ffmpeg/ffmpeg.exe` in the bundle > `shutil.which`), one shared
   helper, both call sites use it.
6. **D-fixes ship in the same package** (they are 401/ACL/state-param fixes,
   each < 30 lines; shipping a known trust bug to save a day is a bad trade).

## Workstream A — Backend data relocatability (`MN_DATA_DIR`)

> Prerequisite for B and C. Also fixes the test-isolation hazard.

### A1. Config + path helper
- `backend/app/config.py`: add `data_dir: str = ""` to `Settings`.
- New `backend/app/paths.py` (or extend config.py — keep it one obvious
  place):
  ```python
  def data_root() -> Path:
      configured = get_settings().data_dir
      if configured:
          return Path(configured)
      return Path(__file__).resolve().parents[1] / "var"   # == backend/var
  ```
  Expose `audio_dir()`, `snapshot_path()`, `voiceprint_path()`,
  `local_sharepoint_dir()` as functions (not import-time constants) so tests
  and the packaged app can retarget via env without import-order traps.
- **Gotcha for the implementer**: `store.py`'s `SNAPSHOT_PATH` today resolves
  `parents[1]` (=> `backend/var/store.json`) while the three service files use
  `parents[2]`. They point at the same directory; unify on `data_root()`.

### A2. Consumer refactor
- Replace the four constants at `store.py:89`, `services/pipeline.py:37`,
  `services/voiceprints.py:18`, `services/sharepoint.py:26` with calls to the
  A1 helpers. `services/retention.py:14` imports `AUDIO_DIR` from pipeline —
  update it too. Grep for any other `AUDIO_DIR` / `SNAPSHOT_PATH` /
  `VOICEPRINT_PATH` / `LOCAL_SHAREPOINT_DIR` importers before considering
  this done (`mic_track_path()` in pipeline is one).
- `mkdir(parents=True, exist_ok=True)` on first write must be preserved.

### A3. Test isolation (closes the 2026-07-04 store-clobber incident)
- Shared test bootstrap (e.g. `backend/tests/conftest_env.py` imported first,
  or `unittest` `setUpModule` pattern consistent with the existing suite):
  set `MN_DATA_DIR` to a `tempfile.mkdtemp()` **before** any `app.*` import,
  and clear the `get_settings` lru_cache.
- Acceptance: `PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v`
  run twice in a row leaves `backend/var/store.json` mtime and content
  unchanged (verify with checksum before/after).

### A-verification
- All existing tests pass (32+ at last count).
- Manual: `MN_DATA_DIR=/tmp/mn-data uvicorn app.main:app --port 8788` →
  create a meeting → `store.json`, `audio/` appear under `/tmp/mn-data`,
  repo `var/` untouched.

## Workstream B — Backend bundle (PyInstaller onedir + ffmpeg)

> **Must build on Windows.** The dev venv is WSL-side; PyInstaller produces
> host-platform artifacts only. Local proof: create `backend\.venv-win` with
> Windows Python, or do it in CI. Do not attempt to cross-build from WSL.

### B1. Entry point + spec
- `backend/run_backend.py`: programmatic uvicorn launch
  (`uvicorn.run("app.main:app", host="127.0.0.1", port=8787)`), reading
  `MN_BACKEND_PORT` override for future flexibility. Needed because
  `python -m uvicorn` isn't available inside a frozen app.
- `backend/meeting-notetaker-backend.spec`: onedir, name
  `notetaker-backend`, hidden imports as discovered (pydantic v2 and uvicorn
  loops are the usual suspects; `uvicorn.logging`, `uvicorn.loops.auto`,
  `uvicorn.protocols.*` frequently need listing), exclude tests.
- Add `pyinstaller` to a new `backend/requirements-build.txt` (keep runtime
  `requirements.txt` clean).

### B2. ffmpeg
- Ship `ffmpeg.exe` (BtbN/gyan.dev LGPL **essentials** build; record the exact
  URL + sha256 in the spec or a `backend/third_party/README.md`) at
  `<bundle>/ffmpeg/ffmpeg.exe` via spec `binaries`/`datas`.
- New helper `find_ffmpeg()` in `services/audio_checks.py` implementing the
  locked discovery order; replace both call sites
  (`audio_checks.py:36`, `routers/meetings.py:157`).
- License note: LGPL build, distributed unmodified alongside the app —
  acceptable for internal tooling; keep the source URL recorded.

### B3. Bundle smoke script
- `scripts/smoke-backend-bundle.ps1`: start `notetaker-backend.exe` with
  `MN_DATA_DIR=%TEMP%\mn-smoke`, poll health endpoint, POST a tiny webm from
  `recordings/` fixtures, assert pipeline reaches a terminal state (stub
  providers fine — no keys needed for the smoke), assert ffmpeg volumedetect
  ran (recorder_audio_missing set true/false, not null), kill process.
- Acceptance: script passes on a machine with **no** Python and **no** ffmpeg
  on PATH.

## Workstream C — Electron integration

### C1. Ship the bundle
- `electron-builder.yml`: keep `files: ['!backend/**']` (source stays out of
  asar); add
  ```yaml
  extraResources:
    - from: backend/dist/notetaker-backend
      to: backend
  ```
- `package.json`: `package:win` script that asserts the bundle exists before
  invoking electron-builder (fail loud, not a broken installer).

### C2. Supervisor (`src/main/backend-supervisor.ts`)
- On `app.whenReady` (packaged builds only — dev keeps the external WSL
  uvicorn workflow; gate on `app.isPackaged`, consistent with existing
  `is.dev` usage in `src/main/index.ts`):
  1. Health-probe `127.0.0.1:8787` (existing health router). Healthy →
     adopt, don't spawn (dev/dual-instance safety; single-instance lock
     already prevents two packaged copies).
  2. Else spawn `<resources>/backend/notetaker-backend.exe` with
     `cwd=<resources>/backend`, env = `process.env` + `%PROGRAMDATA%` file
     (C4) + `MN_DATA_DIR=<userData>/backend-data`.
  3. Pipe stdout/stderr to the existing `logger.ts` `backendLog` (the path
     already exists — `src/main/logger.ts:21` — it's just never fed).
  4. Poll health until ready (cap ~20s) before the renderer needs it; on
     crash, restart with backoff (e.g. 1s/5s/25s, max 3 in 5 min, then
     surface a tray/dialog error — no silent infinite restart loop).
  5. `before-quit`: kill child, wait briefly, force-kill. Never leave an
     orphan uvicorn holding 8787.
- Failure UX: if the backend never becomes healthy, show an actionable error
  (tray tooltip + dialog with `backend.log` path), don't let every screen
  quietly fall back to sample data — that's the renderer's offline behavior
  and it would mask a broken install.

### C3. Update feed + version
- `electron-builder.yml` publish URL: leave `REPLACE_ME` but add a
  `# BLOCKED:` comment referencing E1 — installer builds must not fail on it
  (electron-updater is only consulted at runtime; verify `checkUpdates` IPC
  degrades gracefully when the feed 404s — it already has a try/catch path,
  confirm with a log line).

### C4. `%PROGRAMDATA%` credentials file
- Supervisor-side parser for `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env`
  (KEY=VALUE, `#` comments, CRLF-tolerant). Missing file → spawn with stubs
  active (app works, providers stubbed) and log a clear one-liner.
- `docs/rollout-runbook.md` (new): per-machine install steps for the test
  team — install exe, create backend.env from a checked-in
  `backend.env.template` (placeholders only, no real keys in repo), enroll 3
  voiceprints, sanity checklist. This doc is the IN-92/IN-96 raw material.

## Workstream D — Trust/security fixes (ship in the same package)

### D1. SharePoint: refuse instead of fake-"saved"
- `routers/meetings.py` SharePoint endpoint: when no Graph token **and**
  `MN_SHAREPOINT_DRIVE_ID` is configured → set
  `sharepoint_status=failed` with "SharePoint sign-in is required…" and raise
  401 — mirror `email_notes` (`routers/meetings.py:310-320`) exactly.
- Keep `LocalSharePointProvider` reachable **only** when drive id is
  unconfigured (true dev-stub case) and label the UI status accordingly
  ("saved to local stand-in", not "saved to SharePoint") — or simpler: keep
  provider selection as-is for unconfigured dev and only add the 401 branch.
  Implementer picks the smaller diff; the invariant is: **a user with a
  configured SharePoint but missing/consent-lacking token must see failure,
  never "saved" with a file:// URL.**
- Test: configured-drive + no-token → 401, status failed, transcript/summary
  untouched (mirror the existing email-failure test).

### D2. `email_notes` ACL
- Add `require(meeting_id, actor, AccessRole.editor)` at the top of
  `email_notes` (`routers/meetings.py:293`). Editor matches the other
  delivery mutations at `:220`/`:267`; audit log already records recipients.
- Test: viewer-role actor → 403; owner → still sends.

### D3. OAuth `state` parameter
- `auth-msal.ts`: generate `state = randomBytes(16).toString('base64url')`
  alongside the PKCE codes; pass in `getAuthCodeUrl`; in the callback
  handler (`:318`) reject (404 + keep waiting, or resolve null) any request
  whose `state` doesn't match. Belt-and-braces with PKCE; closes the
  accept-any-`code` gap, which matters most on the WSL `0.0.0.0` dev bind.

## Workstream E — External/blocked (not executable by an agent)

| Item | Owner | Blocks |
|---|---|---|
| E1 Blob update-feed URL + container | Joseph/David | electron-updater; NOT the installer itself |
| E2 Code-signing cert | David/DV | CI signed release; test team can run unsigned with SmartScreen "More info → Run anyway" documented in runbook |
| E3 Org pyannote + spend-capped OpenAI keys (IN-82/IN-97) | David | backend.env contents per machine |
| E4 `GET /audio` auth | deferred | acceptable loopback-only for Slice 1; revisit if backend host ever ≠ 127.0.0.1 |
| E5 Intune Win32 wrap (IN-89 follow-through) | after E2 | not needed for 4-person manual installs |

## Workstream F — Verification (installed build, real Windows)

Run on at least one machine that is NOT the dev machine:

1. Fresh install from the NSIS artifact → app launches → backend child
   visible in Task Manager → Settings shows healthy state (no "sample data"
   notice anywhere).
2. Manual record → stop → pipeline reaches `ready` with stub or real keys →
   transcript email 401s without sign-in (honest failure), succeeds after
   sign-in.
3. **Live auto-start E2E** (never yet observed working — the IN-68 reserved
   items): calendar meeting → auto-start within ±3 min → auto-stop within
   60 s of end → upload → pipeline. Cold-start variant: reboot, app in tray
   via login item, same flow with window never opened.
4. Quit app → backend child gone, port 8787 released. Crash backend
   (taskkill) → supervisor restarts it → recording upload still succeeds.
5. Data lands under `%APPDATA%\meeting-notetaker\backend-data`, repo/ install
   dir stays clean; uninstall leaves user data (document in runbook).
6. `31d711e` guardrail check: record with mic muted at OS level → silent-mic
   banner appears live; resulting meeting flagged `recorder_audio_missing`.

## Ordering & handoff notes for the execution agent (hermes)

```
A1 → A2 → A3 ──┐
               ├→ B1 → B2 → B3 ──→ C1 → C2 → C4 ──→ F
D1, D2, D3 ────┘   (D can run parallel to A/B; must merge before F)
```

- **Environment**: dev backend runs under WSL (`backend/.venv/bin/python`),
  Electron dev app on the Windows host. B builds REQUIRE Windows-side Python.
- **Discipline that has bitten us three times**: after any backend code
  change, restart the running uvicorn before judging behavior. Check
  file mtime vs process start time if unsure.
- **Do not run `unittest discover` before A3 lands** on a machine with real
  data, or back up `backend/var/store.json` first.
- Commit style: one commit per workstream letter-number (A1, A2…), each with
  tests passing (`typecheck`, `build`, backend suite, `verify:graph`,
  `git diff --check`), evidence appended to `docs/jira-progress.md` under
  IN-81.
- The plan's file:line references are valid at `31d711e`; re-verify before
  editing if history has moved.
