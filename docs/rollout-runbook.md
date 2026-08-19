# Test-team rollout runbook

Target: test team — Benjamin Bryant, David Ahlhaus, Jose T (plus Joseph's
own machine).  Each person gets a Windows machine with the app installed
manually — no Intune, no group policy.

## Pre-flight (Joseph or David, once per machine)

1. **Install the app**
   - Download the NSIS installer from the CI release artifact
     (`meeting-notetaker-*-setup.exe`).
   - Run the installer.  Windows SmartScreen may warn "Windows protected
     your PC" — click **More info → Run anyway** (unsigned until the code
     signing cert lands, Workstream E2).
   - Spend-capped team keys (OpenAI + pyannoteAI) are **bundled in the
     installer** — no per-machine key setup required for initial rollout.

2. **Launch the app**
   - Start "Meeting Notetaker" from the Start Menu or desktop shortcut.
   - The app should open to the Home screen.  Check the tray icon —
     tooltip should read "Meeting Notetaker — Idle" (not "Backend
     unavailable").
   - No "sample data" notice should appear anywhere in the UI.

## Per-user setup (each test-team member)

1. **Sign in with Microsoft**
   - Click **Sign in** in the top bar.
   - The system browser opens an Entra ID consent prompt.
   - After consent, the browser shows "You can close this window."
   - The app displays the user's name and email.

2. **Configure audio** — read this whole step; it prevents the two
   known audio pitfalls.
   - Open **Settings → Audio Setup**.
   - Select a microphone.  Speak to verify the level meter moves.
   - Leave system audio capture enabled for Teams/Zoom meetings.
   - **Use a wired or built-in microphone during recorded calls.**
     Bluetooth headsets (AirPods etc.) can silently record nothing while
     a Teams call holds the headset's hands-free profile.  If the red
     "Microphone appears silent" banner appears while recording, your
     voice is NOT being captured — switch mic and restart the recording.
   - **When testing with a second device in the same room** (e.g. joining
     the same Teams call from a phone), mute the second device's
     microphone.  An open second mic feeds your voice back through the
     call and every word appears twice in the transcript.

3. **Voiceprints**
   - Joseph, David, Benjamin, and Jose T are **pre-enrolled in the central
     voiceprint store**. The installer no longer ships biometric seed data;
     after Microsoft sign-in, the enrollment check resolves their existing
     central records so they can record immediately.
   - Confirm the app finishes the voiceprint check without showing the
     enrollment wizard. The test installer intentionally provides a zero-touch
     setup for this group.
   - Daniel Vucetic and Gabby Berman are intentionally **not** pre-enrolled.
     They should complete the enrollment wizard to test consent and the three
     short voice samples, using the same wired or built-in microphone used for
     recording. They are also intentionally outside the controlled expansion
     list, so their enrollment path and speaker attribution can be assessed
     without special treatment.

4. **Record a test meeting**
   - **Manual**: Click **Record** on the Home screen, speak for ~30
     seconds, click **Stop**.
   - Wait for the pipeline to finish (Processing → Ready).  Real
     providers are bundled — expect an actual transcript of what you
     said, attributed to your name (not "Unknown").
   - Verify the meeting appears with a transcript.

5. **Send transcript email** (requires Graph sign-in)
   - On the completed meeting, click **Send Email**.
   - If not signed in, the app prompts for Outlook sign-in.
   - After sign-in, the transcript is emailed to the recording user.

## Sanity checklist

- [ ] App launches without errors on a cold boot
- [ ] Tray icon visible; tooltip shows "Idle" (not "Backend unavailable")
- [ ] No "sample data" notice anywhere in the UI
- [ ] Microsoft sign-in completes successfully
- [ ] People/enrollment check completes without a wizard for all four centrally enrolled testers (Joseph, David, Benjamin, Jose T)
- [ ] Manual recording → pipeline completes → transcript visible
- [ ] Email sends after Graph sign-in
- [ ] **Live auto-start**: schedule a Teams meeting → app in tray →
      recording starts automatically within ±3 min of start → stops
      within 60 s of end → pipeline runs
- [ ] Quit app → backend child gone, port 8787 released
- [ ] Crash backend (taskkill /f /im notetaker-backend.exe) → supervisor
      restarts it → recording still works
- [ ] Data lands under `%APPDATA%\meeting-notetaker\backend-data`, not
      the install directory
- [ ] `recorder_audio_missing` flag set correctly:
      mute mic at OS level → record → banner shows during recording →
      meeting flagged on completion

## Key rotation

Team keys (OpenAI + pyannoteAI) are bundled in the installer.  To rotate
keys without reinstalling, drop an override file on each machine:

1. Create `C:\ProgramData\Factor1\MeetingNotetaker\backend.env` with the
   new key values:

   ```
   MN_OPENAI_API_KEY=sk-new-key-here
   MN_PYANNOTE_API_KEY=new-pyannote-key-here
   ```

2. Restart the app.  The supervisor merges this file **on top** of the
   bundled keys — any key present in ProgramData wins.

3. After the next CI release ships with the new keys bundled, the
   ProgramData overrides can be removed (optional — they'll keep
   overriding harmlessly).

## Auto-record trigger (v2.0.30+)

- **What changed**: a scheduled Teams meeting's recording now starts on
  your *join* to its Teams call, not at calendar start time. The 3-minute
  arming lead before scheduled start is unchanged (recording never begins
  earlier than that); if you join late, recording still starts
  as soon as you're in the call, at any point up to the meeting's scheduled
  end (a join after the scheduled end is not recorded — start manually).
- **The prompt**: if you haven't joined by start + 2 min, a toast offers
  **Record now**. It shows once per meeting, auto-dismisses after 2 min
  with no action taken, and is suppressed entirely while a recording is
  already in progress.
- **Notifications (19 Aug, with DA)**: every auto-started recording now
  shows a sticky **Recording started** toast naming the meeting, with the
  reminder to tell everyone it is being recorded — no toast means the
  trigger did not fire (you joined early, or you're in the room without
  clicking Join): start manually or wait for the prompt. Toasts stay on
  screen 2 min (the 5-minutes-to-go warning stays 5 min) and disappear as
  soon as the recording stops or is extended.
- **False-start rule**: a join-triggered recording that ends via the
  leave-grace window before start + 2 min, and lasted under 5 minutes, is
  discarded — no email is sent, and the meeting re-arms so a later real
  join still records normally. The paused toast's **Upload now** action
  always delivers regardless of this rule, so a deliberate save is never
  silently dropped — and, unlike a discarded false start, the meeting is
  then *not* re-armed (one recording per meeting still holds).
- **Kill switch**: set `MN_AUTO_START_TRIGGER=calendar` in
  `%PROGRAMDATA%\Factor1\MeetingNotetaker\backend.env` and restart the
  app to restore the legacy start-time trigger on that one machine.
  Fleet-wide, set the `MN_AUTO_START_TRIGGER` repo variable to `calendar`
  and cut a new release. The setting is read from `backend.env`, **not**
  `resources\.env.production` — auto-update overwrites everything under
  `resources\` on every install, so a `resources\.env.production` edit
  would not survive the next update. Note that `calendar` restores the
  *start* behaviour only: the live meeting's attach poller keeps the 5 s
  cadence introduced with this feature (previously 10 s). That is
  harmless — leave-detection is simply a little quicker — and needs no
  separate switch.
- **Log lines to look for**: `[app] auto-start trigger`,
  `[join-watch] armed`, `[join-watch] starting recording`,
  `[join-watch] prompting`, `[recording] false start discarded; meeting
  re-armed`, `[join-watch] start failed before ack; re-arming`.
- **Known limits / comms**:
  - Hybrid/in-room meetings that still carry a Teams link now need one
    click on the "Record now" prompt — nothing starts automatically
    unless you actually join the Teams call.
  - **Joining from your phone with your laptop open elsewhere still
    records the laptop** — the trigger only knows the laptop's own call
    membership, not which device the user is actually speaking from
    (F1; a local device check is the next feature, not yet built).
  - A watch registered after a call has already started is blind to that
    call's join signal — the user only gets the start+2 min prompt, not
    an automatic start, for that meeting.
