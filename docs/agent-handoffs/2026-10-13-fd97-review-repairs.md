# FD97 review repairs — local smoke-test handoff

## Scope and status

The four approved review repairs are complete in `feature/fd97-desktop-integration`.
All implementation remains uncommitted. No PR, CI run, merge, installation,
publication, additional tester enablement or participant send was performed.
The original private QA worktree is not the rebuilt source of truth.

## Repairs

1. Automatic stop reliability: scheduled, join-triggered and prompted stops now
   retain the original identity and deliver/discard decision until acknowledgement.
   Capture-stop failures do not declare the recording idle. Every dispatch catches
   synchronous IPC-send failure and keeps retry armed. Retries stop after ACK or
   replacement. The renderer rejects stale stops by exact capture key for every
   recording source; prompted calls additionally require the original call nonce.
   Auto and timed-manual starts preserve that key in the renderer session.
2. Calendar refresh queue: a rejected queued full refresh is released; later
   concurrent full refreshes run rather than replaying the stale rejection.
   Startup, periodic and resume refreshes handle rejection explicitly.
3. Cancelled/declined bookings: these do not suppress an ad-hoc suggestion.
   Other uncertain/excluded Teams bookings retain conservative suppression.
4. Native identity: a fresh OS process snapshot can exclude a verified unrelated
   window after its direct identity query fails. A failed/unavailable snapshot or
   inaccessible Teams identity remains uncertain. Window ownership is rechecked.

## Fresh executed verification

- 29 Node desktop/main verification scripts passed, including 44 Teams core
  checks and seven review checks. Stop regressions cover scheduled/prompted/join
  retries, unchanged delivery decisions, ACK cancellation and IPC-send failure.
- Full isolated backend: 516 passed, 2 skipped, 51 subtests passed; no deselections.
  Provider configuration disabled, temporary data, outer network guard enabled.
- Synthetic backend HTTP processing integration: seven passed.
- Rust: 14 tests passed (nine protocol, four identity, one real OS-snapshot check);
  format check and release helper build passed.
- Typecheck and production Electron build passed.
- Real built renderer/preload handoff: nine synthetic scenario checks passed,
  then the same runner passed against the actual packaged ASAR with zero provider
  requests. This is not proof of new live participant mail receipt.
- Actual frozen backend on an owned private port: synthetic dual-track processing
  reached ready, bundled FFmpeg ran, both tracks saved, no delivery invoked.
- Package resource inspection: current main/preload/renderer and staged
  backend/native/FFmpeg hashes match; private launchers, recordings and compiled
  test fixtures excluded. Approved provider configuration staged without printing
  values and remains outside ASAR in the normal approved resource layer.
- Capture-only smoke snapshot: fresh sign-in rendered, synthetic storage bytes
  read back, audio upload/email/SharePoint/participant-resolution routes denied,
  separate private port, installed backend PID/health/protected-data unchanged.
  All copied application files and the repaired native helper match this build.

## Built artifacts

`dist/Meeting Notetaker-2.0.41-setup.exe`

- Bytes: 171223477
- SHA-256: 69379f7a346918fc2b55986f6cd143f3d068513419fbc56502c7cc488d67c26c
- Authenticode: NotSigned
- Built with `npm run package:win -- --publish never`.

This is a local, same-version preparation candidate, not a release. Do not install
it over production or replace the published artifact. Final versioning/signing,
PR/CI and publication remain separate steps.

## User smoke test

`dist/fd97-call-test/Start Smoke Test.cmd` starts an unpackaged capture-only snapshot
of this repaired build, using the existing private test launcher/relay and a fresh
private repair-test profile. It does not install or update production. It has no
copied provider keys; processing, participant lookup and delivery are blocked.
It is deliberately ignored and excluded from the distribution.

The next user action is to open the command and sign in in the test window.
Then test a fresh consenting unscheduled Teams call. Keep acceptance separate for
screen sharing, actual hang-up stop and saved tracks, explicit Continue recovery,
unanswered timeout with the observer still unavailable, unanswered timeout after
healthy observer recovery, and explicit Stop while Teams remains connected.
A capture-only upload-failed notice after local save is expected.

No real-call smoke verdict is claimed by this handoff. Preserve capture evidence
before restarting because the existing startup recovery can clean ready captures.
