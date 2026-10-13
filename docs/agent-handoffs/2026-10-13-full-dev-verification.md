# Full-function dev trial — verified preparation

Source implementation: `bfda458` on `feature/fd97-desktop-integration`.
The conversational full-function, fixed-build trial design was approved before
implementation. Current remote head and checks are authoritative on GitHub.

## Deliverable

`dev-notetaker.cjs` starts the real backend/pipeline with existing privately
reused provider settings, central enrollment, normal Storage API/SharePoint,
recorder delivery and existing participant approval. It is not the capture-only
relay. Run the generic setup and teammate/Claude instructions in
`full-function-dev-trial.md`.

The dev profile/session/audio/logs/temp, loopback port, AUMID and toast scheme are
separate from the installed app. Native Windows kill-on-close job ownership
prevents a forced Electron exit orphaning its backend. Bounded crash recovery has
an explicit Retry backend / Quit choice. Installed auto-start and updater remain
unchanged. A normal startup refuses a concurrently running installed app.

## Executed verification

- TDD initial missing runtime baseline, cleanup idempotency, legacy-install
  configuration precedence, restart-limit manual recovery and launcher ownership
  wiring all failed before their respective implementations and then passed.
- 30 desktop/main-process verification scripts passed, including 11 full-dev
  checks, 44 Teams prompt checks and seven original review regressions.
- Full network-blocked isolated backend suite: 516 passed, 2 skipped and 51
  subtests passed; no local deselections. Seven synthetic processing HTTP
  integration tests passed separately.
- Native helper: 14 tests passed; release build passed.
- Node/web typecheck, fixed desktop/native build and nine real built-renderer/
  preload handoff scenarios passed. No provider request in the renderer fixture.
- Real Windows job fixture: force-terminated only the fixture parent; Windows
  terminated its owned backend without JavaScript shutdown hooks. No application
  process or live provider was involved.
- Fresh detached checkout, with source-copy hashes checked, ran the ordinary
  setup path: npm ci, new Python 3.12 venv, checked-in backend requirements,
  downloaded SHA256-pinned FFmpeg archive, Windows libarchive extraction,
  full-dev tests, job test, typecheck and native/desktop build.
- The fresh build then ran the actual launcher/main/preload/renderer and ordinary
  backend with a marked private fixture profile. Fresh sign-in UI rendered,
  synthetic silent dual-track audio reached pipeline ready, delivery remained
  not_started, and normal quit stopped the owned backend. No real provider,
  email, cloud write or protocol registration was invoked by this smoke.
- Existing installed listener PID, health and nonempty protected meeting/voiceprint
  hashes matched before/after both the original and fresh-checkout launch smoke.
- Independent source review identified orphaned-backend and exhausted-restart
  defects; both were repaired and verified. Follow-up review found no high/medium
  source defects. Review conclusions are not live account acceptance.
- Explicit publication manifest excluded ignored configuration, recordings,
  encrypted caches, biometric state and private live-call evidence. No added
  provider-key/token/private-account evidence was found. Source history starts
  from the clean baseline rather than private QA commits.

The first fresh setup failed when an external 7-Zip install was absent. The
repaired setup uses Windows System32 libarchive (not GNU tar earlier on PATH)
and retains 7-Zip only as a fallback. The unchanged npm lockfile reports existing
dependency vulnerabilities; no automatic audit-fix/major upgrade was performed.

## Server gate readback

The requested additional tester's exact Entra identity was verified as enabled
before editing. Only the lookup OID allowlist was extended; the existing tester
was preserved, giving two explicit testers rather than unrestricted enablement.
Lookup remains enabled and temporary diagnostics remain disabled. Exact
allowlisted settings were read back, and cloud /health/live plus /health/ready
returned HTTP 200 after propagation. No identity/token/private call data is
recorded here. The tester's own authenticated lookup still requires their sign-in.

## Remaining live acceptance and release boundary

Preparation is ready for the tester, not proof that their PC/account has passed
all features. After setup/sign-in verify enrollment, delegated permissions,
calendar polling, native call readiness, consented recording, real transcription/
voice identity, cloud artifacts, existing approval and recipient inbox receipt
as separate checkpoints. Provider-config presence is not credential validity or
credit balance. Real normal use consumes existing provider credits.

Keep the installed app closed during dev use. Start the dev version manually
after login. Hold the recorded commit through the trial; close it before any
approved rebuild. Return to the installed app only after the dev app quits and
its owned backend stops. Do not uninstall or delete either profile.

No main merge, version bump, release tag, installer execution/upload or updater
publication is authorized by this preparation. The earlier unsigned 2.0.41
installer repair candidate is historical and is not this full-dev trial route.
CI retains one pre-existing backend concurrency-test deselection; report its
actual run separately rather than calling it the local full-suite gate.
