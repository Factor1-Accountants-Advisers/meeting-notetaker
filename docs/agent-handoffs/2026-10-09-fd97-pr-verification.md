# FD97 desktop integration — verification and release boundary

## Integration scope

Prompted unscheduled Teams capture reuses the existing recording, transcription,
summary, storage, owner approval and participant-delivery paths. Participant
sharing itself is production-proven; new acceptance covers observer/capture
safety, delayed participant resolution and the recovery handoff.

The observer must use a fresh complete calendar snapshot, require explicit
recording consent, pause on uncertain call evidence, and resume only after an
explicit Continue decision. Conclusive same-call hang-up stops/saves capture.
Nonce and active-recording guards prevent stale decisions stopping another call.
The original interval and trusted attendees survive stale uploads and restart.
Participant lookup never establishes a speaker's voice identity.

Delayed lookup does not block recorder processing/delivery. Resolved participants
reach the existing owner approval flow. Stored approval resumes only when policy
is enabled, candidates exist and participant delivery is not_started, sharing the
same single-flight guard as explicit Send. In-flight, completed, failed and
unconfirmed sends are never automatically retried. Recorder email fields are not
reset by participant lookup.

## Local verification

- Full network-blocked backend suite: 516 passed, 2 skipped, 51 subtests passed;
  no deselections in the local full-suite run.
- 28 Node verification scripts at the regression checkpoint passed, including
  Graph, recording controls, Teams prompt/recovery, ownership and package policy.
- The subsequently added real built-renderer/preload integration runner passed
  nine synthetic scenario checks, including late lookup → approval → existing
  delivery pass, approved restart recovery, no repeats and policy/decline guards.
  It was also run against the actual packaged ASAR. Provider requests: zero.
- Native Rust suite: nine passed; the release helper built successfully.
- Synthetic HTTP processing harness: seven passed; the real backend endpoints
  and processing state machine run with explicit local provider adapters.
- Recorder-only/lookup boundary tests passed locally; those machine-specific
  live-QA helpers and private call evidence are intentionally not in this PR.
- Typecheck, production Electron build and local NSIS packaging passed with an
  explicit --publish never. Package inspection verified current main/preload/
  renderer and backend/helper/FFmpeg hashes, excluding test launchers, compiled
  verification files, recordings and the separate credentials file from ASAR.
- The actual shipped frozen backend ran on an owned private port with synthetic
  dual-track audio and disabled credentials. It reached ready, executed bundled
  FFmpeg and saved both tracks without invoking delivery. Installed backend PID,
  health and nonempty protected-store hashes matched before/after.
- The shipped native helper emitted valid endpoint/Teams JSON records during a
  bounded read-only smoke. Only owned smoke process trees were stopped.

Key reusable checks:
- scripts/verify-fd97-renderer-handoff.cjs
- scripts/verify-fd97-packaged-backend.py
- scripts/verify-fd97-package-resources.cjs
- scripts/verify-fd97-package-policy.cjs
- scripts/verify-fd97-processing.py
- scripts/verify-prompted-call-recovery.ts
- scripts/verify-teams-call-prompt.ts

The renderer fixture runs without production main, uses synthetic IPC/auth
replies, blocks network and denies media access. These assertions are contract
checks, not a claim of new live participant mail receipt. Frozen-backend smoke
uses synthetic input/local credential-disabled provider stubs; prior consenting
live processing and delayed lookup evidence remain separate private QA records.

## Release boundary

No installer was executed, no normal production-main startup/registry changes
were performed, and no update, participant email or recording artifact was
published by these preparation checks. The local candidate is unsigned and
retains the baseline version 2.0.41 solely for preparation; it must not replace
the published artifact of that version. Choose/bump the next release version and
use the existing signing/updater release workflow only after explicit release
approval. The release workflow publishes from v* tags; this PR does not invoke it.

Desktop prompted-call enablement remains opt-in. Broader rollout/cohort changes,
DA enablement, merge and publication are separate approval gates. The temporary
cloud diagnostic was disabled after investigation; production correlation and
voice-matching thresholds were not relaxed.

This is not installed-Windows UAT or proof of every reconnect/group-call case.
The healthy-observer-recovery unanswered-timeout case remains outside earlier
live evidence. Do not close Jira merely because preparation checks pass.

## Independent review and CI

The Hermes subagent could not start because its provider rejected authentication;
that failed attempt supplies no code-review evidence. The replacement read-only
Codex CLI review completed: no high-severity findings, four medium findings in
scheduled stop-failure recovery, rejected queued calendar refreshes, cancelled/
declined booking suppression, and unrelated process-query failures affecting the
native observer. Isolated source probes reproduced the calendar issues; the queue
poisons subsequent concurrent forced refreshes, not every idle refresh. The
scheduled-stop/native conditions were checked in source, not live fault-injected.
The four repairs were approved and completed in the integration worktree.
Fresh post-repair regressions, native build, Windows package and isolated
packaged-component checks passed; see 2026-10-13-fd97-review-repairs.md.
Desktop implementation remains uncommitted; no PR, installation or publication.
The user's fresh live Teams smoke test remains the next acceptance step.
No private live-call handoff/history or machine-specific test launcher is included
in this public-source branch.
