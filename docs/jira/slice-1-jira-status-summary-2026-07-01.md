# Notetaker Slice 1 Jira status summary

Date: 2026-07-01

Sources checked:
- `C:\Users\JosephMiguelGuerrero\Downloads\Jira (2).csv`
- `/home/josephmiguelguerrero/projects/meeting-notetaker-2/docs/jira-progress.md`
- `/home/josephmiguelguerrero/projects/meeting-notetaker-2/docs/implementation-plans/2026-07-01-long-meeting-pipeline-slice1-plan.md`
- PR #2: https://github.com/Factor1-Accountants-Advisers/meeting-notetaker/pull/2

## Quick status list

### Complete / Done

- `IN-65` — Spike: MS Graph meeting detection — subscription vs polling
- `IN-66` — Wire auto-start and auto-stop recording to Graph meeting events
- `IN-67` — Implement host-only recording gate for auto-triggered meetings
- `IN-68` — Implement MS Graph meeting detection in Electron main process
- `IN-70` — Define internal vs client meeting_type classification rules
- `IN-71` — Configure app to run at Windows startup and persist in system tray
- `IN-72` — UI cleanup: remove per-calendar-meeting Record button
- `IN-73` — Evaluate removal of meeting list and calendar strip
- `IN-74` — UI cleanup: remove full meeting detail page
- `IN-75` — UI cleanup: remove action items view and aggregated action items page
- `IN-77` — UI updates: auto-recording status alongside manual recording
- `IN-83` — Test: Auto-recording starts for meeting organiser
- `IN-84` — Test: Auto-recording is suppressed for non-organiser
- `IN-85` — Test: Manual recording still works for in-room/ad-hoc use
- `IN-87` — Test: Unregistered speaker stored as anonymous/Unknown
- `IN-88` — Test: Per-meeting Record button absent; manual controls and audio setup present
- `IN-89` — Confirm Win32 app Intune requirements with DV
- `IN-93` — Implement MS Outlook emailing of transcript
- `IN-95` — Define MS Outlook emailing of transcript
- `IN-98` — Check how often we can poll Graph reliably / MS restrictions

### Ongoing / In Progress

- `IN-64` — Parent: Slice 1 — Auto-Triggered Recording, Pyannote Speaker ID, and UI Modernisation
- `IN-69` — Wire Pyannote transcription and voiceprint identification into production pipeline
- `IN-76` — Admin voiceprint upload and registration utility
- `IN-78` — Implement attendee-first voiceprint candidate selection
- `IN-79` — Implement voiceprint candidate expansion rules for key uninvited people
- `IN-80` — False-positive suppression for non-attendee detections
- `IN-81` — Packaging, signing, and installer update
- `IN-82` — Confirm PyannoteAI API availability, credentials and costs for production
- `IN-86` — Test: Known speaker identified by voiceprint with high confidence
- `IN-91` — Define private SharePoint directory for transcript saving
- `IN-94` — Test: transcript saved then emailed to correct persons
- `IN-97` — Get org account for Pyannote
- `IN-98` — Check how often we can poll Graph reliably / MS restrictions

### Not Started / Blocked

- `IN-92` — Create F1 wide comms
- `IN-96` — Communicate with DV and Gabby on Scope/Handover/Coms

## Detailed task evidence

### IN-65 — Spike: MS Graph meeting detection — subscription vs polling

Recommended status: Complete / Done

Why: Polling vs webhooks was evaluated and Electron main-process delegated Graph polling was selected for Slice 1.

Acceptance criteria met: Recommendation made; Graph scopes identified; /me/calendarView baseline documented; webhook tradeoffs documented; throttling/backoff rules documented; polling cadence documented.

Evidence: docs/spikes/ms-graph-meeting-detection.md; live validation update; poll cadence immediate startup/sign-in/resume plus 5-minute normal polling.

Unmet criteria / blocker: Persistent MSAL token cache is a follow-up hardening item, not a blocker for the spike decision.

### IN-66 — Wire auto-start and auto-stop recording to Graph meeting events

Recommended status: Complete / Done

Why: Graph event detection is wired to recording lifecycle and upload metadata.

Acceptance criteria met: Auto-start path exists; auto-stop timer exists; manual recording bypasses calendar logic; Graph metadata passes through create/upload/backend record.

Evidence: docs/jira-progress.md IN-66; commits 1df29d8, 0000990, 9b74905; npm run verify:graph; typecheck; build; backend compileall; FastAPI smoke for create/upload with Graph metadata.

### IN-67 — Implement host-only recording gate for auto-triggered meetings

Recommended status: Complete / Done

Why: Auto-recording is organiser-gated and non-organiser meetings are skipped.

Acceptance criteria met: Organiser passes; non-organiser blocked; excluded events blocked; manual recording bypasses host gate.

Evidence: src/main/graph/host-gate.ts; docs/jira-progress.md IN-67; commit e25c4e3; live 2pm Innovations Sync check showed David as organiser so Joseph should not auto-record.

### IN-68 — Implement MS Graph meeting detection in Electron main process

Recommended status: Complete / Done with auth-persistence follow-up

Why: MSAL public-client auth, Graph calendar polling, host gate, start-window gate, and duplicate protection are implemented.

Acceptance criteria met: Detects real Teams calendar meetings; uses delegated Graph; emits eligible/skipped decisions; auto-start only inside 3-minute window; skips non-organiser meetings.

Evidence: docs/jira-progress.md IN-68; commits cf2a475, a59bd92, bb33e2c; src/main/graph/runtime.ts; DEFAULT_POLL_INTERVAL_MS=5 minutes; DEFAULT_AUTO_START_LEAD_MS=3 minutes.

Unmet criteria / blocker: Current app loses cached MSAL account after restart. Add persistent MSAL cache as hardening/follow-up.

### IN-70 — Define internal vs client meeting_type classification rules

Recommended status: Complete / Done

Why: Jira already marks Done and classification rule was decided.

Acceptance criteria met: Internal/client classification rules documented and accepted as initial Slice 1 logic.

Evidence: Jira (2).csv shows IN-70 Done; comments confirm team agreed to initial rules.

### IN-71 — Configure app to run at Windows startup and persist in system tray

Recommended status: Complete / Done

Why: Tray behavior, startup/background launch behavior, single-instance handling, and opt-out setting are implemented.

Acceptance criteria met: App persists in tray; packaged builds can launch at login; single-instance prevents duplicates; tray status updates with recording state.

Evidence: docs/jira-progress.md IN-71; commits a7db862 and 0630750; npm run typecheck; npm run build; git diff --check.

Unmet criteria / blocker: Final signed installer rollout remains under IN-81.

### IN-72 — UI cleanup: remove per-calendar-meeting Record button

Recommended status: Complete / Done

Why: Calendar meeting list/per-meeting Record button is removed while manual controls remain.

Acceptance criteria met: No per-calendar meeting Record button; manual Start/Stop remains available.

Evidence: docs/jira-progress.md IN-72/IN-88; dashboard cleanup under IN-73.

### IN-73 — Evaluate removal of meeting list and calendar strip

Recommended status: Complete / Done

Why: Decision made to remove meeting list/calendar strip for simpler Slice 1 UI; Jira already marks Done.

Acceptance criteria met: Decision documented; UI implementation follows decision.

Evidence: Jira (2).csv IN-73 Done; outcome says these can be removed for simpler UI; docs/jira-progress.md dashboard cleanup.

### IN-74 — UI cleanup: remove full meeting detail page

Recommended status: Complete / Done

Why: Meeting detail/review route was removed for Slice 1 production handoff.

Acceptance criteria met: Full detail page absent; transcript/summary/waveform/speaker review/export controls absent.

Evidence: Latest PR commit e7b99a7 fix: align slice 1 UI and long-meeting plan; docs/jira-progress.md IN-74; MeetingReviewScreen route removed from App.tsx.

### IN-75 — UI cleanup: remove action items view and aggregated action items page

Recommended status: Complete / Done

Why: Action item page/view and dashboard card were removed.

Acceptance criteria met: No action items tab/page; no aggregated action items page; actions delivered in email/output instead.

Evidence: docs/jira-progress.md IN-75; UI cleanup evidence under IN-73/74/75.

### IN-77 — UI updates: auto-recording status alongside manual recording

Recommended status: Complete / Done

Why: Dashboard/tray status reflects auto-recording and processing state.

Acceptance criteria met: Shows recording status; shows processing status; manual active recording view preserved.

Evidence: docs/jira-progress.md IN-77; commit 132cb77.

### IN-83 — Test: Auto-recording starts for meeting organiser

Recommended status: Complete / Done with packaged-startup caveat

Why: Live smoke showed organiser Teams event was detected and auto-recording triggered.

Acceptance criteria met: Signed-in organiser meeting detected; host gate passed; auto-record triggered; duplicate/spam safeguards present.

Evidence: docs/jira-progress.md IN-68 live smoke: Graph returned real Teams event, host gate passed, renderer confirmed recording started.

Unmet criteria / blocker: Re-test from cold Windows startup after persistent MSAL cache is added.

### IN-84 — Test: Auto-recording is suppressed for non-organiser

Recommended status: Complete / Done

Why: Host gate blocks non-organiser meetings.

Acceptance criteria met: Non-organiser meeting does not auto-record; skip reason is not_organizer.

Evidence: docs/jira-progress.md IN-67/IN-68; runtime logs showed reason not_organizer, autoRecordEligible false, hostGateAllowed false.

### IN-85 — Test: Manual recording still works for in-room/ad-hoc use

Recommended status: Complete / Done

Why: Manual recording path was tested with actual .webm output and backend processing.

Acceptance criteria met: Manual start works without calendar meeting; upload works; backend processes recording.

Evidence: docs/jira-progress.md IN-85; actual 97 KB .webm recording; create/upload/process flow verified.

### IN-87 — Test: Unregistered speaker stored as anonymous/Unknown

Recommended status: Complete / Done

Why: Runtime avoids guessing staff names and stores unknown speakers as Unknown.

Acceptance criteria met: Unregistered speaker labelled Unknown/anonymous; unknown count persisted; no Slice 1 correction UI.

Evidence: docs/jira-progress.md IN-87; review endpoint returned participant name Unknown 1 known false; unknown_speaker_count exists.

### IN-88 — Test: Per-meeting Record button absent; manual controls and audio setup present

Recommended status: Complete / Done

Why: Calendar Record button/detail/action UI is absent and manual/audio setup remains.

Acceptance criteria met: No per-meeting Record button; no detail/action views; manual recording remains; Settings > Audio Setup remains.

Evidence: docs/jira-progress.md IN-88; npm run typecheck; npm run build; git diff --check.

### IN-89 — Confirm Win32 app Intune requirements with DV

Recommended status: Complete / Done

Why: DV provided Intune Win32 packaging guidance and repo packaging notes were updated.

Acceptance criteria met: DV requirements requested; DV response received; packaging direction reflected in repo.

Evidence: Jira (2).csv IN-89 comment with Intune guide; docs/jira-progress.md IN-81 notes electron-builder.yml updated with Intune Win32 note per DV.

### IN-93 — Implement MS Outlook emailing of transcript

Recommended status: Complete / Done with IN-94 E2E caveat

Why: Graph email provider and transcript attachment flow are implemented.

Acceptance criteria met: Transcript can be emailed as .txt attachment; calendar-linked recipients use attendees; manual fallback uses recorder; missing token returns 401; email actions audit logged.

Evidence: docs/jira-progress.md IN-93; GraphEmailProvider; build_transcript_attachment(); api-proxy.ts X-MN-Graph-Token; scripts/verify-email-jira-flow.py.

Unmet criteria / blocker: End-to-end recipient testing remains under IN-94.

### IN-95 — Define MS Outlook emailing of transcript

Recommended status: Complete / Done

Why: Jira marks Done and spike/definition chose delegated user Outlook/Graph send.

Acceptance criteria met: Email approach defined; permissions identified; linked implementation task IN-93 exists.

Evidence: Jira (2).csv IN-95 Done; comments mention Mail.Send permissions and successful spike test.

### IN-64 — Parent: Slice 1 — Auto-Triggered Recording, Pyannote Speaker ID, and UI Modernisation

Recommended status: Ongoing / In Progress

Why: Many child tasks are complete, but Slice 1 is not yet handoff-ready.

Acceptance criteria met: Graph detection, host gate, UI cleanup, tray/startup, manual recording, and email implementation are largely complete.

Evidence: PR #2 open and mergeable; docs/jira-progress.md; long-meeting plan.

Unmet criteria / blocker: Persistent MSAL cache; real voiceprint confidence proof; SharePoint write smoke; backend stages/OpenAI chunking; signed installer; comms/handover.

### IN-69 — Wire Pyannote transcription and voiceprint identification into production pipeline

Recommended status: Ongoing / In Progress

Why: Pyannote diarization/transcription path exists, but known-speaker voiceprint identification is not fully proven end-to-end.

Acceptance criteria met: pyannoteAI diarize/transcription path added; fake owner/first-speaker matching removed; unknown-first behavior implemented.

Evidence: docs/jira-progress.md IN-69; backend/app/services/speech.py; speaker_matching.py; pipeline.py.

Unmet criteria / blocker: Need /v1/voiceprint + /v1/identify proven with real staff voiceprint; confidence per segment/evidence model; long-meeting timeout/stages.

### IN-76 — Admin voiceprint upload and registration utility

Recommended status: Ongoing / In Progress

Why: Enrollment backend/UI path exists but actual staff enrollment and central registry behavior are not complete.

Acceptance criteria met: UI records 3 clips with consent; fake local success removed; backend confirmation required; Pyannote API key configured; backend calls /v1/voiceprint.

Evidence: docs/jira-progress.md IN-76.

Unmet criteria / blocker: Live enroll actual staff sample; verify provider voiceprint persisted; verify raw clips deleted; later add required signed-in-user central registry gate.

### IN-78 — Implement attendee-first voiceprint candidate selection

Recommended status: Ongoing / In Progress

Why: Design exists but attendee-first candidate selection is not fully implemented/proven against real identify output.

Acceptance criteria met: Candidate-order design documented in long-meeting plan.

Evidence: docs/jira-progress.md IN-78; long-meeting plan Phase speaker identity model.

Unmet criteria / blocker: Build candidate list from attendees first; add organiser/recorder next; cap list; run end-to-end test.

### IN-79 — Implement voiceprint candidate expansion rules for key uninvited people

Recommended status: Ongoing / In Progress

Why: Design direction exists but implementation/proof is incomplete.

Acceptance criteria met: Expansion concept documented.

Evidence: docs/jira-progress.md IN-79; long-meeting plan candidate order.

Unmet criteria / blocker: Controlled key-person list, cap limits, confidence thresholds, false-positive handling, and decision note/test still needed.

### IN-80 — False-positive suppression for non-attendee detections

Recommended status: Ongoing / In Progress

Why: Unknown-first runtime behavior exists, but real Pyannote identify threshold suppression is not validated.

Acceptance criteria met: Fallback no longer guesses staff names; unidentified speakers remain Unknown.

Evidence: docs/jira-progress.md IN-80.

Unmet criteria / blocker: Tune/enforce identify thresholds; suppress short non-attendee detections; store diagnostic-only possible detections; validate with real output.

### IN-81 — Packaging, signing, and installer update

Recommended status: Ongoing / In Progress

Why: Local package directory build works, but signed installer/Intune-ready artifact is not fully proven.

Acceptance criteria met: Version bumped; electron-builder.yml updated; package:dir verified; backend secrets excluded.

Evidence: docs/jira-progress.md IN-81; npm run package:dir.

Unmet criteria / blocker: Signing certificate/CI release and Intune deployment validation still pending.

### IN-82 — Confirm PyannoteAI API availability, credentials and costs for production

Recommended status: Ongoing / In Progress

Why: API key exists and auth has worked, but org account/cost/data-residency confirmation is not complete.

Acceptance criteria met: Local MN_PYANNOTE_API_KEY exists; /v1/test auth noted as passing.

Evidence: backend/.env has MN_PYANNOTE_API_KEY set; docs/jira-progress.md IN-76; Jira comment says personal API key for now.

Unmet criteria / blocker: Confirm org-owned account, cost per audio hour, voiceprint storage limits, data residency, and production secret storage.

### IN-86 — Test: Known speaker identified by voiceprint with high confidence

Recommended status: Ongoing / In Progress

Why: No clean acceptance-quality evidence yet that a registered staff voiceprint is identified with confidence in stored transcript.

Acceptance criteria met: Voiceprint enrollment path exists partially.

Evidence: docs/jira-progress.md IN-76 and IN-69 say live voiceprint/identify proof remains.

Unmet criteria / blocker: Need registered speaker sample, controlled test recording, confidence > threshold, stored transcript names, and no in-app review UI.

### IN-91 — Define private SharePoint directory for transcript saving

Recommended status: Ongoing / In Progress

Why: Folder target is identified but app write permissions are not proven.

Acceptance criteria met: Target SharePoint folder identified.

Evidence: Target URL: https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/Transcriptions/Forms/AllItems.aspx; long-meeting plan SharePoint decision.

Unmet criteria / blocker: App currently requests User.Read, Calendars.Read, Mail.Send only; needs SharePoint/Files/Sites scopes and upload smoke test.

### IN-94 — Test: transcript saved then emailed to correct persons

Recommended status: Ongoing / In Progress

Why: Email implementation exists but complete app-flow recipient tests are not all proven.

Acceptance criteria met: Backend allows email after pipeline ready; recipient resolution implemented; manual fallback exists; email endpoint can send.

Evidence: docs/jira-progress.md IN-94; IN-93 implementation; manual Outlook send of David meeting notes succeeded but was outside intended app automatic flow.

Unmet criteria / blocker: Need fresh Teams-invitee E2E, ad-hoc E2E, bounce/failure scenario, and auto-send after processing without stale frontend state.

### IN-97 — Get org account for Pyannote

Recommended status: Ongoing / In Progress

Why: Local key exists but org ownership and production approval are not confirmed.

Acceptance criteria met: A Pyannote key is configured locally for development/testing.

Evidence: Jira IN-97; Jira IN-82 comment says personal API key for now, set up org API key later; backend/.env has key set.

Unmet criteria / blocker: Need David/DV confirmation of org account, billing owner, approved secret storage, production usage.

### IN-98 — Check how often we can poll Graph reliably / MS restrictions

Recommended status: Complete as covered by IN-65/IN-68, or Ongoing if standalone note required

Why: Polling facts are already documented and implemented, but Jira may want a standalone closure note.

Acceptance criteria met: 5-minute normal poll; immediate startup/sign-in/resume sync; Retry-After/backoff; no tight near-start Graph polling.

Evidence: docs/spikes/ms-graph-meeting-detection.md; src/main/graph/runtime.ts DEFAULT_POLL_INTERVAL_MS=5*60*1000.

Unmet criteria / blocker: If kept separate, write a short standalone Graph polling/rate-limit note and link IN-65.

### IN-92 — Create F1 wide comms

Recommended status: Not Started / Blocked

Why: Communications/change-management work depends on handover/comms ownership decisions.

Acceptance criteria met: None yet for the F1-wide comms deliverable.

Evidence: Jira (2).csv IN-92 says awaiting answer from Gabby on handover requirements.

Unmet criteria / blocker: Awaiting Gabby/handover requirements and decision on comms owner/timing.

### IN-96 — Communicate with DV and Gabby on Scope/Handover/Coms

Recommended status: Not Started / Blocked until meeting starts; then In Progress

Why: Stakeholder alignment is not complete yet.

Acceptance criteria met: Some DV input exists for Intune, but the full scope/handover/comms decision is not complete.

Evidence: Jira (2).csv IN-96 lists Explain Scope, Define Handover process, Decide who does comms and how.

Unmet criteria / blocker: Needs DV/Gabby stakeholder discussion and decisions.
