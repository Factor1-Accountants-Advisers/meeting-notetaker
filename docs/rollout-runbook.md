# Test-team rollout runbook

Target: 4-person test team (David + 3 accountants).  Each person gets a
Windows machine with the app installed manually — no Intune, no group policy.

## Pre-flight (Joseph or David, once per machine)

1. **Install the app**
   - Download the NSIS installer from the CI release artifact
     (`meeting-notetaker-*-setup.exe`).
   - Run the installer.  Windows SmartScreen may warn "Windows protected
     your PC" — click **More info → Run anyway** (unsigned until the code
     signing cert lands, Workstream E2).

2. **Create the credentials file**
   - Copy `backend.env.template` to:
     `C:\ProgramData\Factor1\MeetingNotetaker\backend.env`
   - Replace the `REPLACE_ME` placeholders with:
     - `MN_OPENAI_API_KEY` — David's spend-capped OpenAI key
     - `MN_PYANNOTE_API_KEY` — org pyannoteAI key (IN-82/IN-97)
   - Leave SharePoint/Azure Blob empty for now (stubs active).

3. **Launch the app**
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

2. **Configure audio**
   - Open **Settings → Audio Setup**.
   - Select a microphone.  Speak to verify the level meter moves.
   - Leave system audio capture enabled for Teams/Zoom meetings.

3. **Enroll voiceprints**
   - Open **Settings → People**.
   - Click **Enroll Voiceprint**.
   - Follow the prompt: read the displayed sentence aloud 2–3 times.
   - Enrollment must complete with a success confirmation.
   - Repeat for 2 additional colleagues (3 enrolled minimum per the
     Slice 1 plan).

4. **Record a test meeting**
   - **Manual**: Click **Record** on the Home screen, speak for ~30
     seconds, click **Stop**.
   - Wait for the pipeline to finish (Processing → Ready).  Stub
     providers will produce a generic transcript; that's expected.
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
- [ ] Voiceprint enrollment succeeds (3 people)
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
