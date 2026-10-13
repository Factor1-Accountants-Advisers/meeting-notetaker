# Full-function Windows dev trial — teammate / Claude handoff

## Goal and boundaries

Run `feature/fd97-desktop-integration` on the tester's native Windows PC for a
week. This is the normal Notetaker pipeline plus the new unscheduled Teams-call
feature, not the capture-only or recorder-only QA relay.

Keep recording, transcription, voiceprint identification, summaries, normal
Storage API/SharePoint outputs and existing owner-approved participant delivery
available. Do not rebuild established sharing or disable it merely to test the
new recording source. Real processing consumes the existing provider credits;
normal email and cloud writes can occur during real use. Obtain normal recording
consent. Never lower matching thresholds, bypass enrollment, or share without
existing approval.

No installer, tag, release, main-branch merge, updater-feed write or fleet-wide
enablement. Never run two Notetaker instances for the same meeting. The installed
app is the rollback option; do not uninstall it or erase its state.

## Prerequisites

- Native Windows, Teams desktop, and the tester's own Factor1 Microsoft account.
- Existing Notetaker installation recommended: its private bundled provider config
  is reused without copying keys into source, logs or chat. A per-machine
  ProgramData override retains precedence. GitHub access is not runtime enrollment.
- Node.js 22+, npm, Python 3.12 and Rust/Cargo with the Windows build tools.
  Windows tar extracts FFmpeg; 7-Zip is only a fallback on older Windows builds.
  Claude may inventory tools; missing system-tool installs require the tester's
  normal approval process.
- Working existing enrollment and delegated Graph permissions for calendar,
  email and SharePoint. Verify after the tester signs in; setup is not proof of
  eligibility, remaining credit, credential validity or recipient inbox receipt.
- The caller's Entra account must be in the server participant-lookup tester
  cohort. This is a server-side gate; a local feature flag cannot bypass it.

## Pull and prepare

Use a dedicated checkout/worktree; do not overwrite another dirty checkout.

    git clone https://github.com/Factor1-Accountants-Advisers/meeting-notetaker.git
    cd meeting-notetaker
    git switch feature/fd97-desktop-integration
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-full-dev.ps1

The setup script runs npm ci, creates the repo's backend/.venv, installs the
checked-in backend requirements, stages the pinned/hash-verified FFmpeg if
missing, runs dev safety tests/typecheck and builds the fixed desktop/native
helper. It never requests a provider job, launches the app, or installs an update.
A compatible Python path can be passed with -PythonExe. -SkipInstall is only for
an already-verified dependency environment, not the normal fresh-machine path.

Record the exact `git rev-parse HEAD` used for the week. Do not pull or edit while
recording or processing; close the dev app first, then rebuild after changes.

## Launch and normal use

1. Quit the installed Notetaker using its tray menu. Do not kill process trees by
   image name, uninstall it, or modify its auto-start setting. The dev launcher
   refuses normal startup if it detects the installed app running.
2. Open `out/Start Dev.cmd` in Explorer or native PowerShell outside Claude's MSIX
   shell. This avoids sandbox-redirected AppData confusing the tester's Explorer.
   Alternatively use `npm run start:dev` from an ordinary native terminal after
   setup. Keep that terminal open when using this alternative.
3. Sign in with the tester's own account and satisfy the existing enrollment gate.
4. Verify private backend health and actual recording readiness: signed-in actor,
   renderer ready, complete fresh calendar, recurring polling, and native helper.
5. Make a short consenting unscheduled Teams call, share screen, hang up, then
   verify saved audio, real processing, named-speaker evidence and recorder mail
   receipt separately. A mere healthy window or sendMail acceptance is not success.
6. When late participants resolve, verify the existing approval prompt and normal
   send behavior; assert no recorder resend. Participant identity is not a
   retroactive voice-label update. Then continue normal scheduled/manual use.

The app stays in the tray when its window closes. Start it manually after each
Windows login during the trial; the installed app may auto-start, so quit that
instance first. The dev build deliberately does not replace Windows auto-start
or consume/install normal updater releases. There is no hot-reload server.

## Isolation and private configuration

- Window title: Meeting Notetaker Dev; separate AUMID and `notetaker-dev://`
  activation. The existing tray menu/tooltips are retained.
- Profile: `%LOCALAPPDATA%/MeetingNotetaker-Dev`.
- Local meetings, audio/spill, authentication, logs and temp files stay under that
  profile, not the installed app or backend/var.
- Backend binds a freshly selected loopback port, never 8787. It uses the ordinary
  `backend/run_backend.py`, not a restricted test relay, and restarts only its
  owned child after unexpected exit with a bounded restart policy. Exhaustion
  displays an explicit Retry backend / Quit choice. A validated, parent-owned
  Windows kill-on-close job prevents orphaned backends even after a forced exit.
- `%LOCALAPPDATA%/MeetingNotetaker-Dev/dev-runtime.json` records the current port
  and owned PID, with no credentials. Rediscover after relaunch.
- Private settings are read from installed app bundle locations, then ignored
  repo backend.env/backend/.env/backend/dev.env, then the existing ProgramData
  override. Only approved operational/provider fields are selected; production
  data directories and ports are never inherited. Default central endpoints are
  shared with the desktop, not guessed.
- Startup fails rather than silently using fake speech/summary output if required
  provider config is missing. Ask for secure configuration help; never paste or
  print keys to Claude, GitHub, terminal output or messages. Do not copy token
  caches, voiceprint registries or recordings into the repo.

## Stop and rollback

Wait for recording/processing/delivery to finish, then Quit the DEV app from its
tray. Verify its owned backend stops; preserve relevant audio and private logs
before cleanup. Open the existing installed app to return to the published
version. Do not delete either profile or replay uncertain delivery automatically.
Use the approved server kill-switch/cohort procedure if lookup needs rollback;
no production setting changes should be made by the tester's Claude session.

## Copy-paste Claude prompt

Help me run the full-function Notetaker dev trial from the approved feature
branch on this Windows PC. Read this handoff and AGENTS.md; this handoff takes
precedence over old machine-specific dev/reset instructions. First inspect my
checkout and available tools without changing an unrelated dirty repo. Use the
setup script and fixed dev launcher, not ordinary npm run dev, the capture-only
relay, scripts/restart-dev.ps1 or a packaged installer. Reuse existing installed
provider config privately; do not print secrets or ask me to paste keys. Never
reset installed data, change its startup, kill processes by image/port, merge,
tag, publish, modify cloud settings or widen recipient policy. After setup, have
me quit the installed app and sign in in the dev window. Verify actual enrollment,
calendar polling and recording readiness, then guide one consenting call test at
a time. Separate recording, provider processing, participant lookup, speaker
identity, approval and real mail receipt. Keep normal features available for my
week of use and record the exact commit and failures without claiming live
success from fixture tests.
