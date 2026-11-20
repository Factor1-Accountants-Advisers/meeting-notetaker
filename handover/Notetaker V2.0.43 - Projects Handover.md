# Notetaker Projects Handover — Rollout Guide for Accounting Teams

| | |
|---|---|
| Audience | Projects department (rollout planning, training, comms) |
| Application version | 2.0.43 |
| Document date | 16 November 2026 |
| Prepared by | Innovations team (innovations@factor1.com.au) |
| Status | In production pilot. Deployed to first users via Intune. Screenshots from the old UI have been removed; the app's interface was redesigned in this release, and screenshots will be re-captured for the training pack. |

> **Screenshots.** The published V2.0.15 copy in SharePoint holds the screenshots. This Markdown review copy marks each one in place as *[Screenshot from V2.0.15: …]*. They carry over unchanged when the guide goes back into Word.

## Contents

1. What Meeting Notetaker does
2. User guide
3. Key limitations — what the tool does not do
4. Privacy, consent and data handling
5. Rollout planning
6. Support and feedback
7. Version history

## 1. What Meeting Notetaker does

Meeting Notetaker is a Factor1-internal Windows app that takes the note-taking burden out of meetings. It records the audio of a meeting, works out who said what, and delivers a written transcript, a summary and a list of action items to the meeting host by email. Nothing needs to be typed during the meeting.

### 1.1 What a user gets

- A full transcript of the meeting with each contribution attributed by name for ANY enrolled Factor1 colleague (voiceprints are now shared centrally; you enrol once and every Factor1 Notetaker recognises you). Unrecognised voices appear as "Speaker 1 / Speaker 2"
- A summary and extracted action items, generated automatically.
- One email to all meeting attendees shortly after the meeting ends
- Two files saved to the SharePoint Transcriptions library
  - "&lt;date&gt; &lt;title&gt; - Transcript.md" and;
  - " - Summary.md"

  with attendees granted view access automatically. If someone can't be granted, the files still save and the app says who to share with manually.

### 1.2 How it works day to day

- **Teams meetings the user organises:** recording starts by itself within about 3 minutes of the scheduled start and stops at the scheduled end. The user does not need to do anything except leave the app running in the system tray (it starts with Windows by default).
- **In-person or ad-hoc meetings:** the user types a meeting title on the Home screen and presses "Start Recording", then "Stop" when done.
- **Meetings organised by someone else:** the app deliberately does not auto-record these — only the organiser's machine records. Anyone can still record manually if appropriate.
- The app keeps itself up to date automatically every 4 hours. There is also a manual update button if the patch is urgent.

> **Important framing for comms**
> The tool records audio of meetings that routinely contain confidential client information. Rollout comms should cover when it is appropriate to record, how clients are informed, and the firm's policy on mandatory recording for compliance. The app enforces staff voiceprint consent by default.

## 2. User guide

This section is written to be lifted straight into training material. Screenshots are from version 2.0.15.

### 2.1 Install and first launch

1. IT installs the app remotely via Intune. Most users have nothing to download. (If installing manually on a non-managed machine, Windows may show a blue "Windows protected your PC" SmartScreen message: click "More info", then "Run anyway". This does not appear on IT-managed machines.)
2. Start "Meeting Notetaker" from the Start Menu. From then on it starts automatically when Windows starts and lives in the system tray (the ^ area near the clock).

### 2.2 Sign in with Microsoft

1. Click "Sign in with Microsoft".
2. Your normal web browser opens with the Factor1 Microsoft sign-in. Complete it (including MFA if prompted).
3. When the browser says sign-in is complete, close it and return to the app. Your name appears in the top-right corner.
4. Notetaker shows **Checking your voiceprint** for a few seconds, then opens the Home screen.

If Notetaker later shows **Sign in again**, your Microsoft sign-in has stopped working on this computer. Click **Sign in again** and finish the Microsoft sign-in in your browser. Your voiceprint is safe, so you don't record a new one.

*[Screenshot from V2.0.15: The sign-in screen shown on first launch.]*

### 2.3 Enrol your voiceprint (one-off, required)

The first time you sign in, the app asks you to record a voiceprint — three short voice samples that let it recognise your voice in meetings. You cannot use the app until this is done.

1. Follow the wizard: Welcome → Consent → three voice samples → Done.
2. Tick the consent box (Factor1 stores voiceprints for staff speaker identification only; they are deleted when someone leaves).
3. For each sample, click "Record sample", read the on-screen sentence aloud in your normal meeting voice, and click "Stop sample". Each clip must be 10–30 seconds. The closer to 30 seconds the better for higher accuracy.
4. Use the same microphone you will use in real meetings — ideally a wired or built-in one (see section 2.7).

*[Screenshot from V2.0.15: The voiceprint enrolment wizard.]*

The People screen shows who in the team is enrolled. Colleagues who are not enrolled will appear as "Speaker 1 / Speaker 2" in transcripts rather than by name.

*[Screenshot from V2.0.15: The finished voiceprint enrolment wizard.]*

**Note:** Notetaker asks for a voiceprint only when it has confirmed you don't have one. That screen is **Voiceprint required**. Two other screens mean your voiceprint is safe and you don't enrol again:

| Screen | What it means | What you do |
|---|---|---|
| **Couldn't check your voiceprint** | Notetaker couldn't reach the central voiceprint store. | Check your connection, then click **Try again**. |
| **Sign in again** | Your Microsoft sign-in has stopped working on this computer. | Click **Sign in again** and finish the Microsoft sign-in (section 2.2). |

*[Screenshot from V2.0.15: People screen — enrolment status for the team.]*

### 2.4 Check your audio settings

1. Open Settings (gear icon, bottom-left) → Audio capture.
2. Pick your microphone. Prefer a wired or built-in microphone.
3. Leave "System audio (loopback)" as is — it captures the other participants in Teams calls.

*[Screenshot from V2.0.15: Settings — audio capture, transcription language, theme, start-at-sign-in and updates.]*

### 2.5 Automatic recording of your Teams meetings

For Teams meetings you organise, there is nothing to click:

- Around the scheduled start, recording begins and Windows shows a notification ("Recording: &lt;meeting title&gt;"). A red "Recording now" pill appears in the app's top bar and the tray icon tooltip changes
- Five minutes before the scheduled end you get a warning notification with an "Extend 10 min" button right on the notification — you can also extend from the recording screen or the tray menu.
- Recording stops by itself within a minute of the scheduled end, and processing starts automatically.

> **For auto-recording to work**
> The app must be running (in the tray) and you must be signed in. It only auto-records meetings where YOU are the organiser, and only online Teams meetings — see section 3 for the full list of cases it does not cover.

### 2.6 Recording a meeting manually

1. On the Home screen, type a meeting title (e.g. the client and topic).
2. Click "Start Recording". The recording screen opens with a timer and Pause / Stop controls.
3. When the meeting ends, click "Stop". The app saves and uploads the recording and tells you an email will follow.

*[Screenshot from V2.0.15: Home screen — title first, then Start Recording. "Upload recording" processes an existing audio file instead.]*

*[Screenshot from V2.0.15: The recording screen. Green status lines confirm both your microphone and the meeting audio are being captured.]*

You can also pause, resume, stop or extend a recording by right-clicking the tray icon. Closing the app window does not stop the recording — the app keeps running in the tray. Only "Quit" from the tray menu exits the app.

### 2.7 The one warning to take seriously: a silent microphone

Bluetooth headsets (AirPods and similar) can silently record nothing while a Teams call is holding the headset in its hands-free mode. The app detects this and shows a red banner during the recording:

If you see this banner, your voice is NOT being captured.

1. Switch to a wired or built-in microphone (Settings → Audio capture).
2. Stop and restart the recording.

Related pitfall: if you join the same Teams call from a second device (e.g. your phone) in the same room, mute the second device's microphone.

### 2.8 After the meeting

- The Home screen shows progress: processing, then a green confirmation naming the recipients.
- One email goes to all attendees with the transcript, summary and action items. Expect it within minutes.
- The transcript and summary are also saved to the SharePoint Transcriptions library, with attendees granted view access automatically. If someone couldn't be granted (external guest, distribution list), the app lists who to share with manually.
- If something fails, the Home screen says so honestly (e.g. "Failed: Microsoft sign-in") and offers a retry that resumes only the step that failed. Retrying is always safe, emails never double-send.
- The bell icon in the top bar collects these events, including "N speaker(s) to name" when unrecognised voices were found — unknown speakers can be named during review.

## 3. Key limitations — what the tool does not do

Setting these expectations in training will prevent most support tickets and disappointment. The two starred rows are the ones every user must hear.

| Scenario | What happens | What to tell users |
|---|---|---|
| ★ Identifying colleagues | All enrolled Factor1 staff are identified by name in transcripts. Staff who haven't enrolled show as "Speaker 1/2". | Enrol once and you're recognised everywhere. Nudge un-enrolled colleagues, it takes 5 minutes. |
| ★ Silent microphone | If the mic is muted at OS level the app warns live with a red banner. | Watch for the red banner; check OS mute and the selected device. Device switching mid-meeting now follows automatically. |
| Meetings you did not organise | Never auto-recorded (by design — one recording per meeting, made by the host). | The organiser's machine records. Record manually only when appropriate. If the organiser doesn't attend, consider recording manually. |
| In-person / in-room meetings | Not auto-recorded (no Teams meeting to detect). | Use manual Start/Stop with a meeting title. |
| Zoom / Google Meet | Auto-detection is Teams-only. Manual recording captures system audio from any app | Treat non-Teams calls as "manual recording". |
| Android/iOS/OSX | Windows-only at this stage. | Not available yet, but already planned for future release |
| App not running / user signed out | Nothing is detected or recorded. | Leave the app in the tray; it starts with Windows by default. Quit = no recordings. Do not close your laptop. |
| Meeting created less than ~5 minutes before it starts | The calendar is polled every 5 minutes, so a very last-minute meeting could be missed initially; recording starts as soon as the app sees it. | Start it manually if the notification/pill has not appeared. |
| Clients and guests | Not enrolled, so they appear as "Speaker 1 / Speaker 2", not by name. | This is deliberate (voiceprints are staff-only, with consent). Manually assigning names to speakers feature will come with a later release |
| Reviewing transcripts inside the app | There is no in-app transcript viewer, no editing, and no way to rename speakers yet. The email is the deliverable. | Keep the email; corrections are manual for now. Longterm access via link is coming in later release |
| Live captions / live notes | Not supported — processing is after the meeting ends. | Nothing appears until the meeting finishes. |
| Raw audio retention | Recordings are deleted after 30 days; transcripts, summaries and emails are kept. | Save anything you need from audio within 30 days. |

## 4. Privacy, consent and data handling

- **Voiceprints:** created only for Factor1 staff, only with the person's explicit in-app consent, used solely for speaker identification, and deleted at offboarding. Clients and external attendees are never enrolled.
- **Recordings:** raw audio is kept for 30 days, then deleted automatically. Transcripts and summaries are retained (email, and SharePoint once enabled).
- Meeting data stays on the user's machine and in Factor1's Microsoft 365 tenant; transcription and summarisation use pyannoteAI and OpenAI under Factor1 API accounts.
- **Access:** the app is for authorised Factor1 staff only and requires Microsoft sign-in on every use.

## 5. Rollout planning

### 5.1 Prerequisites (IT — see the companion IT Handover document)

- IT deploys the signed installer via Intune to the Notetaker Users group and pushes the trust certificate (both in place since 3 Aug 2026). After that, the app keeps itself current, there is no per-release deployment work.
- Adding a person to the rollout = IT adds them to the Notetaker Users group.

### 5.2 Per-user onboarding checklist (15 minutes per person)

1. Confirm the app is installed (Intune) and sign in with Microsoft.
2. Complete voiceprint enrolment (3 samples) with the microphone they will actually use.
3. Settings → Audio capture: select a wired/built-in microphone.
4. Record a 30-second test meeting, wait for the email, and confirm their own name (not "Speaker 1") appears in the transcript.
5. Walk through the tray icon: status tooltip, pause/stop/extend, and the fact that closing the window does not quit the app.
6. Show "Report a problem" in Settings, it sends the app logs straight to the Innovations team.

### 5.3 Training messages worth repeating

- "You organise it, it records itself" — and the flip side: someone else's meeting will not auto-record on your machine.
- "Enrol once, recognised everywhere" — and un-enrolled colleagues show as Speaker 1/2, so completeness of enrolment is what makes transcripts readable.
- "Your voiceprint is safe" — **Sign in again** and **Couldn't check your voiceprint** never mean you enrol again. Only **Voiceprint required** asks for a voiceprint.
- "The app updates itself" — never download installers; just restart when the notification asks.
- "Wired mic or headset for recorded meetings" — the single biggest quality factor.
- "The email is the deliverable" — there is nothing to look for inside the app after a meeting.
- If you see the email in your inbox twice, this is because of how Outlook displays conversation history, this is not a double up and can be ignored.

## 6. Support and feedback

| Need | Route |
|---|---|
| Something is broken (install, sign-in, no email, backend errors) | First: the "Report a problem" button in the app's Settings. It goes straight to the Innovations inbox with logs attached. Otherwise the IT service desk; escalation to innovations@factor1.com.au. Ask users to note the meeting title and time. |
| Feature requests and improvement ideas | Ideas Portal [insert link]. The Innovations team triages these into the Notetaker backlog (IN-50). |
| Questions about rollout, training, comms | Projects department, with Innovations as product owner. |
| Policy questions (recording consent, client comms) | HR/Executive — outside the tool's scope. |

Companion document: "Notetaker V2.0.43 — IT Handover" covers architecture, deployment, configuration and troubleshooting for IT.

## 7. Version history

| Version | Date | What changed | Changed by |
|---|---|---|---|
| V2.0.15 | 4 August 2026 | Previous published version. | Innovations team |
| V2.0.43 | 16 November 2026 | Section 2.2: step 4 (**Checking your voiceprint**) and what to do on **Sign in again**. Section 2.3: the note now explains the **Voiceprint required**, **Couldn't check your voiceprint** and **Sign in again** screens. Section 5.3: "Your voiceprint is safe" training message; repeated "app updates itself" message removed. Section 5.2: steps numbered 1–6. Cover and companion-document name: version 2.0.43. | Innovations team |
