# Notetaker mobile fit/gap — Android first, iOS assessed

**Date:** 11 November 2026. **Status:** discovery assessment; proposed scope, not an approved implementation design or release commitment.

## Executive conclusion

**A useful mic-only mobile Notetaker is feasible on Android and iOS. It is not a direct Electron port.** Keep manual ad-hoc recording, durable local capture, authenticated upload and the existing post-meeting AI capabilities. Exclude Windows loopback, automatic Teams-call recording and desktop startup behaviour from the first version.

The largest shared gap is **processing infrastructure**, not the recording buttons. Today the Python process supervised by the desktop orchestrates transcription, speaker identification and summarisation. The separate central Storage API is not, in the inspected checkout, an audio-processing submission service. Uploading audio to Blob alone does not run the pipeline. A secure hosted processing boundary is needed for a standalone mobile app; a desktop-assisted import can instead prove audio compatibility first.

**Recommendation:** approve a bounded Android recording-and-compatibility spike, plus a hosted-ingestion design decision. Use Kotlin/native recording for the spike; do not lock the final shared mobile framework until recording lifecycle and authentication are proven. Keep iOS in the API/data-contract decisions now, and validate its recorder separately on Apple hardware.

## 1. What David and Joseph agreed

Source: three Teams screenshots supplied by Joseph, conversation dated 11 November 2026, approximately 11:51–12:12. This assessment used those screenshots, not a live Teams lookup; it does not claim coverage of unseen messages.

- David will take the SharePoint taxonomy/migration-process work; that is a separate workstream.
- Joseph will investigate porting Notetaker to Android/iOS.
- David explicitly accepts less than desktop parity. His suggested first slice is the existing ad-hoc recording concept, manual start/stop, and the same AI pipeline.
- David requests a fit/gap of current functionality on each platform so useful, simple functionality can be selected.
- The year-end objective is progress, not a ready-to-release mobile app.

**Not yet agreed:** framework, minimum OS versions, supported devices, distribution route, delivery policy, hosted-service architecture, budget or a delivery estimate.

## 2. Evidence and coverage

Desktop checkout: `main`, HEAD `d137f3bca7167bda0087d7b41a52200167bf04a8`, package version 2.0.42. Existing untracked build/helper/tmp work was preserved. Git status reported unreadable pytest-cache directories; this is not a claim of a completely inspected clean tree. The ordinary tracked diff was empty before this report.

Storage API checkout: local `main` HEAD `75e6ec08900326323e12ad6184b9b39545628030`, five commits behind last-fetched `origin/main` (`639052b1014fabd9feb338381f290b7e39a73e65`). A read-only cached-origin comparison found the newer changes add call-record participant lookup/diagnostics, not AI processing. Neither cached reference proves current deployed or live-remote state.

Review method: source inspection of the active UI/capture/auth/API paths, focused backend/central-storage inspection, and official Android/Apple/Microsoft documentation. No app launch, builds, mobile recording tests, production/API probes, paid processing, deployments or messages were performed. Feasibility means a supported implementation path, **not tested feature readiness**.

Android tooling check: `adb`, `sdkmanager`, `java` and `gradle` were not found on this shell's PATH. Android SDK/Studio were absent at their checked default locations. Custom installations were not ruled out; nothing was installed. iOS builds/signing require a suitable macOS/Xcode environment, not this Windows checkout alone.

## 3. What actually runs today

```text
React DOM UI
  -> Electron preload / main IPC
       -> local FastAPI Python process
            -> pyannoteAI / LLM provider calls
            -> local meeting state and audio
            -> central Storage API / Blob
            -> delegated Graph SharePoint / email delivery
```

- AI orchestration runs in the desktop Python process, calling cloud inference; it is not an on-device model: [speech/matching/summary stages](<C:/Projects/meeting-notetaker-2/backend/app/services/pipeline.py#L362-L433>), [in-process task creation](<C:/Projects/meeting-notetaker-2/backend/app/services/pipeline.py#L533-L571>). Completed output/audio is delivered separately: [Blob step](<C:/Projects/meeting-notetaker-2/backend/app/services/pipeline.py#L489-L510>).
- Central meetings routes accept completed exports and issue audio-upload grants; they do not submit processing jobs: [storage router](<C:/Projects/notetaker-storage-api/app/routers/meetings.py#L69-L152>). The existing single-mic/in-person DTO is a useful reusable domain contract, not proof of a hosted API: [meeting DTO](<C:/Projects/meeting-notetaker-2/backend/app/schemas.py#L278-L287>), [audio DTO](<C:/Projects/meeting-notetaker-2/backend/app/schemas.py#L470-L488>).
- The bridge owns requests, authentication, file saves, capture spill recovery and Windows integrations: [preload](<C:/Projects/meeting-notetaker-2/src/preload/index.ts#L93-L203>).
- Main proxies requests to localhost by default and adds Graph/storage identity tokens: [API proxy](<C:/Projects/meeting-notetaker-2/src/main/api-proxy.ts#L23-L26>), [token plumbing](<C:/Projects/meeting-notetaker-2/src/main/api-proxy.ts#L51-L126>).
- **Manual recording currently explicitly selects `online`**, so it attempts microphone plus loopback; do not assume the ad-hoc screen already means mic-only: [manual start](<C:/Projects/meeting-notetaker-2/src/renderer/src/App.tsx#L1182-L1231>), [capture branching](<C:/Projects/meeting-notetaker-2/src/renderer/src/lib/capture.ts#L202-L280>).
- Windows capture grants WASAPI loopback through Electron, without a picker: [media permissions](<C:/Projects/meeting-notetaker-2/src/main/media-permissions.ts#L4-L38>). This cannot be copied into a mobile build.
- Upload is currently a full base64 JSON request, with optional system segments: [upload contract](<C:/Projects/meeting-notetaker-2/src/renderer/src/lib/api.ts#L325-L395>).
- Processing/delivery progression is partly driven by renderer polling. At `ready`, the app initiates its delivery flow: [processing watcher](<C:/Projects/meeting-notetaker-2/src/renderer/src/App.tsx#L1502-L1573>). A suspended phone UI cannot own that durable workflow.

## 4. Fit/gap inventory

**Fit** = supported concept, still requires mobile implementation/testing. **Adapt** = new platform adapter or shared-service changes. **Gap/defer** = no direct equivalent or outside the proposed first slice. Current implementation is distinguished from older guide claims.

| Current capability | Android | iOS | Proposed first-slice treatment / evidence |
|---|---|---|---|
| Ad-hoc title, start and stop | Fit: native mic recorder | Fit: AVAudioRecorder/AVAudioEngine | Include. Use mic-only meeting semantics, no loopback or calendar required. [Manual start](<C:/Projects/meeting-notetaker-2/src/renderer/src/App.tsx#L1182-L1231>) |
| Pause/resume, elapsed time, level/warning UI | Adapt native recording state and meters | Adapt audio-session state and meters | Preserve visible recording state; pause/resume is useful but can follow basic start/stop proof. [Recording UI](<C:/Projects/meeting-notetaker-2/src/renderer/src/screens/RecordingScreen.tsx#L21-L215>) |
| Planned duration, countdown, extend/reminder | Adapt service-owned clock/notification | Adapt audio-session lifecycle and UI | Optional first-slice feature, not an agreed requirement. Never depend on a JavaScript timer while suspended. [Duration defaults](<C:/Projects/meeting-notetaker-2/src/renderer/src/screens/HomeScreen.tsx#L47-L63>) |
| Continue user-started recording while locked/backgrounded | Fit with microphone foreground service and notification | Fit with recording audio session and audio background mode | Core reliability acceptance, not an optional desktop-parity extra. Calls, OS actions and hardware changes can still interrupt. See SDK sources A1, I1, I2 below. |
| System/loopback audio, separate mic/system tracks, device-switch merge | Gap for general Teams/phone-call capture; playback API has strict restrictions | No validated equivalent for arbitrary other-app call capture; ReplayKit is not proof of that ability | Exclude from first slice. Not a promise that every kind of mobile playback capture is impossible. [Current capture](<C:/Projects/meeting-notetaker-2/src/renderer/src/lib/capture.ts#L265-L280>); A2, I3 |
| Bluetooth/headset/default-device handling | Adapt Android audio routing and interruptions | Adapt AVAudioSession route/interruption handling | Start with built-in mic; qualify headsets separately. Do not reuse Windows endpoint IDs. [Settings device integration](<C:/Projects/meeting-notetaker-2/src/renderer/src/screens/SettingsScreen.tsx#L107-L157>) |
| Crash spill, saved recording recovery, retry after restart | Adapt app-private files, persistent queue, recoverable format | Adapt protected files, persistent queue, recoverable format | Include durable local capture and clear recovery state. Current WebM chunk-concatenation recovery does not automatically work for AAC/M4A. [Desktop storage](<C:/Projects/meeting-notetaker-2/src/main/recording-storage.ts#L13-L113>) |
| Existing audio-file import | Fit with platform file picker | Fit with document picker | Optional; useful compatibility shortcut before full app. [Existing import](<C:/Projects/meeting-notetaker-2/src/renderer/src/App.tsx#L1885-L1892>) |
| Microsoft sign-in, persistent session, sign-out | Adapt MSAL Android and mobile redirects/broker | Adapt MSAL iOS, redirects/keychain/broker | Include. Desktop MSAL Node and DPAPI cache do not port. Review tenant/Conditional Access requirements. [Desktop auth](<C:/Projects/meeting-notetaker-2/src/main/auth-msal.ts#L1-L28>), [cache](<C:/Projects/meeting-notetaker-2/src/main/auth-msal.ts#L63-L95>); M1, M2 |
| Staff voiceprint enrollment gate and directory | Adapt central enrollment lookup; reuse enrolled identities | Same | Do not bypass gate. An initial pilot can use already-enrolled staff; a new mobile enrollment wizard can be deferred explicitly. [Current gate](<C:/Projects/meeting-notetaker-2/src/renderer/src/App.tsx#L227-L244>) |
| Recording/consent voice samples | Adapt native short clips, same server validation/consent | Same | If included, bind to authenticated subject and test actual sample quality/format. [Current enrollment UI](<C:/Projects/meeting-notetaker-2/src/renderer/src/components/EnrollmentModal.tsx>) |
| Manual attendees | Fit with authenticated directory and typed addresses | Same | Optional basic metadata; participant candidates and delivery recipients are different permissions. [Picker](<C:/Projects/meeting-notetaker-2/src/renderer/src/components/AttendeePicker.tsx>) |
| Upload audio, offline retry and upload progress | Adapt streaming/file transfer and persistent outbox | Adapt file-backed background URLSession and outbox | Include queued/sending/accepted/failed states. Avoid copying base64 whole-file memory handling. A3, I4; [current upload](<C:/Projects/meeting-notetaker-2/src/renderer/src/lib/api.ts#L374-L394>) |
| Batch transcription, diarization, voiceprint matching | Reuse backend/provider logic after hosting adaptation | Same | Preserve batch processing, candidate/consent rules and unknown-speaker evidence. Not an on-device AI rewrite. |
| Summary, actions and company-context generation | Reuse backend/provider logic after hosting adaptation | Same | Keep provider secrets server-side; preserve delegated context-access semantics. [Context token plumbing](<C:/Projects/meeting-notetaker-2/src/main/api-proxy.ts#L65-L71>) |
| Processing status, failed-job retry, Blob-save retry | Adapt durable server jobs/status API | Same | Include basic status/retry. Separate uploaded, processed and delivered outcomes. [Watcher](<C:/Projects/meeting-notetaker-2/src/renderer/src/App.tsx#L1502-L1573>) |
| SharePoint files, email, invitee approval and replay protection | Adapt hosted delivery/auth orchestration | Same | Reuse policy, not desktop timers. Preserve explicit invitee decision and duplicate-send safeguards; no automatic expansion of sharing. [Delivery route](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L934-L1007>) |
| Review/edit transcript, speaker naming, finalization, action-status APIs | Platform-independent server concepts; mobile screens absent | Same | Defer full review UI unless selected. These APIs existing is not proof the current desktop exposes all corresponding screens. [API models/functions](<C:/Projects/meeting-notetaker-2/src/renderer/src/lib/api.ts#L299-L323>), [finalization checks](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L2068-L2099>) |
| Calendar metadata/host filtering | Graph API can be reused; polling lifecycle must change | Same | Defer calendar integration. Optional later metadata/reminder does not imply permission for unattended mic start. [Calendar runtime](<C:/Projects/meeting-notetaker-2/src/main/graph/runtime.ts#L13-L46>) |
| Scheduled/join-triggered auto-start/stop, Teams call prompts/participant resolution | Gap/defer desktop observation and background-start assumptions | Gap/defer desktop observation and lifecycle assumptions | Exclude. Current service/Graph logic is not a portable phone call-audio recorder. [Teams prompt runtime](<C:/Projects/meeting-notetaker-2/src/main/teams-call.ts#L1-L33>) |
| Windows tray, startup login task, toast protocols, native endpoint helper | Replace with mobile notification/app lifecycle where relevant | Replace with platform UI/lifecycle where relevant | Exclude Windows behaviours; retain explicit recording indicator/stop affordance. [Startup](<C:/Projects/meeting-notetaker-2/src/main/startup.ts#L24-L87>) |
| Voiceprint administration | Technically portable authenticated API; new mobile UI needed | Same | Defer mobile admin. Keep central server authorization; hiding a button is not enforcement. [Admin screen](<C:/Projects/meeting-notetaker-2/src/renderer/src/screens/VoiceprintAdminScreen.tsx>) |
| Settings, theme, report-problem diagnostics | Reuse concepts; new OS settings/log collection | Same | Basic account/theme/help only initially. Redact mobile diagnostics; don't copy desktop log attachment blindly. [Settings](<C:/Projects/meeting-notetaker-2/src/renderer/src/screens/SettingsScreen.tsx#L23-L69>), [report plumbing](<C:/Projects/meeting-notetaker-2/src/main/api-proxy.ts#L73-L100>) |
| Electron installer/updater and local Python supervisor | Replace with signed Android packaging/distribution; no bundled desktop Python | Replace with Apple signing/distribution; no bundled desktop Python | New build/release paths. IT-managed vs store distribution remains a decision. [Updater](<C:/Projects/meeting-notetaker-2/src/main/updater.ts#L1-L36>) |
| Audio retention, audit and meeting access | Reuse policy, implement on hosted jobs and handset copies | Same | Preserve access/audit; specify device cleanup and backup exclusion separately. Existing retention keeps failed/in-flight retry sources. [Retention](<C:/Projects/meeting-notetaker-2/backend/app/services/retention.py#L32-L59>), [access](<C:/Projects/meeting-notetaker-2/backend/app/access.py#L1-L40>) |

## 5. Shared gaps that must be resolved

### Hosted processing and security boundary

Do **not** expose the existing localhost FastAPI unchanged. It trusts a display-name `X-MN-User` actor and permits meetings without ACL entries. Those assumptions are not acceptable for an internet-facing multi-user mobile service: [access implementation](<C:/Projects/meeting-notetaker-2/backend/app/access.py#L1-L40>). Snapshot-on-mutation and in-process reconciliation also need a deliberate durable-service design: [application lifecycle](<C:/Projects/meeting-notetaker-2/backend/app/main.py#L31-L77>).

The central Storage API already has bearer/scope validation and is a better foundation than the local actor-header API: [token validation](<C:/Projects/notetaker-storage-api/app/auth/tokens.py#L63-L90>), [scope dependencies](<C:/Projects/notetaker-storage-api/app/auth/dependencies.py#L10-L57>). However, its inspected meeting-storage routes take caller-supplied meeting/time paths without a meeting-owner/ACL lookup. Scope checking alone must not be mistaken for full per-meeting authorization: [export and SAS routes](<C:/Projects/notetaker-storage-api/app/routers/meetings.py#L69-L152>).

Enrollment also has a server-placement gap: central registration stores completed voiceprints; desktop Python currently extracts them from three consented clips. Reuse existing central enrollments for the initial pilot, or design authenticated hosted clip extraction rather than shipping a provider key: [enrollment implementation](<C:/Projects/meeting-notetaker-2/backend/app/routers/people.py#L229-L367>), [central registration](<C:/Projects/notetaker-storage-api/app/routers/voiceprints.py#L397-L435>).

Proposed responsibilities, not implemented endpoints:

1. Authenticated tenant-scoped meeting creation using validated Entra subject/tenant claims, never a client-supplied owner header.
2. Authorized bounded audio upload (potentially short-lived, narrowly scoped SAS), checksum/length verification and explicit upload completion.
3. Durable processing submission and job state with idempotent retries; one logical recording must not cause duplicate paid jobs.
4. Server-side execution of existing pipeline logic with durable state, provider timeouts and recovery. Keep keys out of mobile binaries; the desktop packaging exception is not mobile authorization.
5. Result/status retrieval and a deliberate delivery handoff. Preserve enrollment, meeting access, consent, recipient-domain and invitee-approval rules.
6. File/job limits, retention, monitoring, rate limits and capacity/cost approval.

### Audio format and upload contract

A practical candidate is mono AAC in M4A/MP4 on both platforms, **subject to real fixture validation**. Do not rename AAC bytes to `.webm`. MIME strings alone do not prove codec/provider compatibility. Check server decoding, duration, silence detection, speaker matching and export with actual mobile files. Choose a recoverable recording/container strategy: a normal M4A may require finalization to remain playable after process death.

**Concrete compatibility defects to address:** mic-only bytes are saved unchanged; non-WebM MIME is assigned a `.bin` path, but pipeline retry searches the `.webm` path. Central audio storage fixes the object name and content contract to `audio.webm` / `audio/webm`. Thus an AAC upload being accepted would not establish working retry or correctly labelled cloud storage. Normalize server-side or consistently extend the format contract before claiming mobile codec support: [raw write](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L534-L554>), [extension selection](<C:/Projects/meeting-notetaker-2/backend/app/services/pipeline.py#L72-L74>), [retry lookup](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L676-L693>), [central fixed contract](<C:/Projects/notetaker-storage-api/app/routers/meetings.py#L127-L138>).

The existing base64 JSON contract duplicates large audio in memory and adds roughly one-third wire size. A bounded compatibility spike may use it through an owned local fixture, but the mobile service should use file/stream transfer, explicit limits and resumable/retry-safe semantics. Never put a long-lived storage credential or provider key on the handset.

### Delivery is not just a provider call

Current desktop UI polls until processing is ready, then starts SharePoint/email delivery. Hosted processing completion must survive UI suspension. Delegated Graph access can expire or require user interaction; an upload-time token cannot be treated as permanent background delivery authority. Decide between a foreground/resumable user delivery step and an approved server delegation design. Do not silently grant application-wide mail/SharePoint permissions.

**Guide drift found:** the older agent guide says email requires finalization, but the inspected delivery route calls a readiness/transcript check rather than a finalization check, and the renderer delivers at `ready`. The separate finalization endpoint still rejects unknown speakers. Report current behaviour separately and obtain a product decision before changing either rule on mobile: [artifact readiness](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L744-L756>), [email route](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L934-L950>), [finalize](<C:/Projects/meeting-notetaker-2/backend/app/routers/meetings.py#L2068-L2099>).

## 6. Implementation approaches

| Approach | Benefit | Main trade-off | Assessment |
|---|---|---|---|
| Native Kotlin Android; Swift iOS later; shared hosted API/pipeline | Direct lifecycle, microphone, MSAL and background-transfer integration; smallest narrow Android recorder | Two UI implementations | **Recommended for the bounded Android feasibility spike.** Final UI framework can still change. |
| React/Capacitor mobile shell with native recording, MSAL and file-transfer adapters | Best reuse of existing React DOM/components and design tokens | Electron IPC must be replaced; reliable recorder must live outside WebView/JS lifecycle; native modules still need maintenance | Credible final-product candidate if UI reuse outweighs adapter costs after the spike. A WebView wrapper alone is insufficient. |
| React Native with native recorder/auth modules | Shared TypeScript/mobile-oriented UI across Android/iOS | Existing HTML/Tailwind DOM screens do not drop in unchanged; native lifecycle modules still required | Credible if simultaneous two-platform delivery becomes the priority. |

No framework choice removes the hosted-processing/security gap. A browser-only recorder/PWA is not the recommended baseline for dependable screen-locked meeting capture.

## 7. Smallest useful milestones and acceptance gates

### A. Android capture and audio-compatibility proof — proposed next work

- Agree target devices/OS floor, maximum meeting duration and built-in-mic baseline; locate/install SDK only with approval.
- User taps Start while visible; permission denial is handled; native service owns capture, file and elapsed state. Show recording notification with Stop; capture continues when screen locks.
- Save locally before transfer, with durable session identity and recoverable partial-file strategy. Clearly report interruptions instead of recording unnoticed silence.
- Prove a short mobile fixture imports through the existing desktop upload flow or an isolated local fixture. This is **desktop-assisted compatibility**, not a standalone mobile backend.
- Validate container/duration and expected room speech locally first. Any paid provider run requires separate approval, synthetic/consented audio and an explicit job budget.
- Do not touch installed Notetaker data, enrollment or production configuration.

### B. Standalone mobile vertical slice — after service design approval

```text
Microsoft sign-in + enrollment check
  -> title / optional attendees
  -> user-started native mic capture
  -> durable local file and upload queue
  -> authenticated hosted ingestion
  -> existing AI logic in a durable worker
  -> processing/result status
  -> approved resumable delivery flow
```

Include sign-in expiry handling, retry-safe acceptance, server-owned job recovery, clear unknown speakers and separate upload/processing/delivery states. Offline capture can be included if the local queue is securely bound to the last authenticated identity; new sign-in/enrollment/AI processing are not offline capabilities. Switching account must not upload the previous user's queued recordings.

### C. iOS equivalent and bounded pilot

Validate native recording/background mode, real-device interruption/route handling, MSAL and file-backed transfer; then reuse the hosted contract. Pilot with a small approved group of already-enrolled staff. Mobile enrollment can be a later explicit milestone. Measure recognition on known room speakers; reusing the provider does not prove equivalent accuracy with a phone on a table.

### Required test matrix before calling the vertical slice usable

- Real-device short capture and a representative agreed meeting length; screen lock, app background/foreground and notification Stop.
- Incoming call/competing microphone, Bluetooth disconnect, audio route changes and permission revocation; clear interrupted/recovered state.
- Low storage, process termination, reboot and recoverable saved/partial files; no claim that recording continues through force-stop/reboot.
- Offline stop, Wi-Fi/mobile-data change, interrupted upload, expired sign-in and account switch.
- Duplicate upload completion/job retry, failed worker restart, long provider job and repeated delivery attempts without duplicate processing/email.
- Invalid/other-tenant token, another user's meeting access, unenrolled/unknown status, unapproved invitees and no provider secrets in packages/logs.
- Real mobile codec/provider compatibility and held-out room-speaker quality, separately from static API tests.

**Year-end progress evidence:** fit/gap reviewed with DA, a real Android capture demonstrator, explicit hosted-service architecture/owner, and recorded acceptance results. This is a proposed milestone, not a calendar estimate or a release promise.

## 8. Decisions for Joseph and David

1. Confirm mic-only, in-room/ad-hoc as the first slice; explicitly exclude online Teams/phone-call capture.
2. Confirm whether the first demonstrator may be desktop-assisted, or must already work independently of a PC.
3. Choose supported pilot devices/OS versions and recording length; establish iOS build/device access.
4. Decide result destination and sharing approval behaviour; resolve the guide/current-code finalization discrepancy deliberately.
5. Approve hosted processing ownership, identity/delegation design, retention and bounded cost before implementation/deployment.

## Official platform references

Retrieved 11 November 2026. These document platform capabilities/restrictions, not tests of this app. API availability must be checked against the chosen OS floor; do not adopt newly documented APIs blindly.

- **A1:** [Android microphone foreground-service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone): RECORD_AUDIO runtime permission, microphone service type/permission, restrictions on background/boot starts. [Native recording](https://developer.android.com/media/platform/mediarecorder).
- **A2:** [Android audio-playback capture](https://developer.android.com/media/platform/av-capture): user MediaProjection consent, same user profile, capturable usages MEDIA/GAME/UNKNOWN and source-app policy. This does not establish capture of Teams communication audio.
- **A3:** [Android persistent work and retry constraints](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work): use network constraints/backoff for queued transfer; not a precise calendar-triggered recording scheduler.
- **I1:** [Apple recording session/background mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/record): recording permission, audio background mode for screen-lock continuation, interruptions still possible. Choose record/playAndRecord behaviour deliberately.
- **I2:** [Apple audio interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions): interruption notifications and version-specific lifecycle APIs.
- **I3:** [Apple ReplayKit recorder](https://developer.apple.com/documentation/replaykit/rpscreenrecorder): documents recording one's own app; not a general arbitrary-app call loopback guarantee.
- **I4:** [Apple background file transfers](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background): background session lifecycle; only file-backed upload tasks survive app exit under the documented supported cases. User force-quit is not a continuity guarantee.
- **M1:** [MSAL Android configuration](https://learn.microsoft.com/en-us/entra/msal/android/msal-configuration): platform redirect URI, authority and broker configuration.
- **M2:** [MSAL iOS configuration](https://learn.microsoft.com/en-us/entra/msal/objc/install-and-configure-msal): app registration, redirect scheme, keychain and broker handling.

## Investigation housekeeping

No application source was changed or committed. This assessment is the only new task deliverable. The tracked `git diff --check` emitted no whitespace findings. A separate untracked-document check using `git diff --no-index ... NUL ...` was sandbox-denied; it was not retried through a workaround. The report was reread directly. Existing untracked work remains untouched.

An explicitly approved, unconfined Windows-permissions repair inspected the workspace/ancestors and added the signed-in user's full-control entry on the workspace root; verification confirmed the missing right was restored and the original confined git command then succeeded. No file contents or owners changed in that repair. The bounded subtree scan reached its 2,000-directory limit; no claim of a complete permission-tree audit is made. No foreign package entries were removed.

Recovery evidence: [permission report](<C:/Projects/meeting-notetaker-2-permission-recovery/acl-report-430970aa49d3484387a743fd03cac81c.jsonl>), [saved original permissions](<C:/Projects/meeting-notetaker-2-permission-recovery/acl-backup-12c25a96a99c4e98ada097573aa2d0c5.json>), [recovery script](<C:/Projects/meeting-notetaker-2-permission-recovery/acl-backup-12c25a96a99c4e98ada097573aa2d0c5.json.ps1>). No rollback was needed or performed. To undo the approved permission change, the script printed:

```powershell
pwsh -NoProfile -File 'C:\Projects\meeting-notetaker-2-permission-recovery\acl-backup-12c25a96a99c4e98ada097573aa2d0c5.json.ps1' -Path 'C:\Projects\meeting-notetaker-2' -AllowRoot 'C:\Projects\meeting-notetaker-2' -Restore 'C:\Projects\meeting-notetaker-2-permission-recovery\acl-backup-12c25a96a99c4e98ada097573aa2d0c5.json'
```

Next step: review the first-slice scope and approve a bounded Android spike before implementation or tooling installation.
