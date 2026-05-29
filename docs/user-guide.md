# Meeting Note-Taker — User Guide

Welcome. This guide walks you through installing Meeting Note-Taker, signing in, checking your audio setup, and recording a meeting — whether it is a scheduled Teams meeting or an unplanned one.

You do **not** need to be technical to use this app. Most steps are one click.

---

## 1. Install the app

1. Locate the installer your admin sent you:
   `Meeting Note-Taker 1.0.0.msi`
2. Double-click the installer.
3. If Windows shows a "Do you want to allow this app to make changes?" prompt, click **Yes**.
4. Follow the installer steps — the defaults are fine.
5. When the installer finishes, Meeting Note-Taker is available from the Start menu.

> **Tip:** A system-tray icon appears near the clock when the app is running. Right-clicking that icon gives you quick access to start or stop a recording without opening the app window.

---

## 2. Sign in

1. Launch **Meeting Note-Taker** from the Start menu.
2. On the welcome screen, click **Sign in with Microsoft**.
3. A Microsoft sign-in window will open. Use your **work Microsoft account** (the same one you use for Teams and Outlook).
4. Approve any permissions the app asks for — it needs read access to your calendar so it can list your upcoming meetings.
5. Once signed in, you land on the dashboard.

> **Note:** You only need to sign in once per machine. The app will remember you the next time you open it.

---

## 3. Check your audio setup

The app records **two streams** and mixes them:

- **Microphone** — your voice.
- **System audio** — the sound coming out of your speakers (this is how the app hears the other Teams participants).

On first launch, the app auto-selects your Windows default microphone and default playback device. In most cases this is correct and you do not need to do anything.

### To verify the setup

1. Click the **gear icon** in the left sidebar to open **Settings → Audio Setup**.
2. Confirm:
   - **Microphone** shows your preferred microphone (e.g. "Microphone Array", a headset, or your webcam's mic).
   - **System Audio** shows the device your Teams meeting audio comes out of (usually your speakers or headphones).
3. If everything looks right, no action needed. If you changed anything, click **Save audio setup**.

### Important Windows setting

For system audio capture to work reliably, Windows must **not** give apps exclusive control of your playback device:

1. Open **Windows Settings → System → Sound**.
2. Under **Output**, click your current speakers/headphones.
3. Scroll to **Advanced** and make sure **"Allow applications to take exclusive control of this device"** is **off**.

You only need to check this once.

---

## 4. Record a scheduled Teams meeting

The dashboard shows your upcoming meetings in a 7-day strip across the top of the left rail.

1. Join your Teams meeting as you normally would.
2. In Meeting Note-Taker, click the day tab that contains your meeting (usually **TODAY**).
3. Click the meeting's card in the list.
4. A panel slides out on the right with your meeting title, time, and attendees. Click **Record**.
5. The dashboard switches to "Your meeting is being captured" and a timer starts counting.
6. Leave Meeting Note-Taker running in the background. You can minimise it — the recording continues.
7. When your Teams meeting ends, come back to Meeting Note-Taker and click **Stop** (either in the app, or by right-clicking the tray icon and choosing **Stop Recording**).
8. The app uploads the recording and begins processing. This takes a few minutes depending on meeting length.
9. When processing finishes, the meeting appears in **Past Meetings** on the left rail, with a summary, transcript, and extracted action items.

> **Why record your own computer's audio?** This approach works with any video-conferencing tool — Teams, Zoom, Google Meet — because it captures whatever you can hear. You do not need to be a meeting organiser, and you do not need the other participants to do anything special.

---

## 5. Record an unscheduled (ad-hoc) meeting

Sometimes a meeting happens on the fly — a hallway chat, a phone call, a quick huddle. You can still capture it.

1. On the dashboard's left rail, below the day strip, fill in the **Meeting Title** field (e.g. "Quick sync with Sarah").
2. Optionally add attendees — type a name and press **Enter** to tag each one. This helps with speaker identification in the transcript.
3. Click **Start Recording**.
4. The timer begins. Leave the app running in the background.
5. When you are done, click **Stop Recording** (in the app or from the tray icon).
6. The recording uploads and processes just like a scheduled meeting.

> **Tip:** You can also upload an audio or video file you already have (for example, a recording exported from Teams). Click the **Upload** button on the dashboard and choose a file — supported formats include `.wav`, `.mp3`, `.mp4`, `.m4v`, and `.mov`.

---

## 6. Review your meeting

After processing completes, click the meeting in **Past Meetings** to open it. You will see:

- **Waveform** — a visual of the captured audio.
- **Summary** — a paragraph overview of the meeting.
- **Key Points** — bullet highlights.
- **Action Items** — tasks with owners and (where mentioned) due dates. You can check these off as they are done.
- **Transcript** — the full speaker-labelled transcript.
- **Export** — copy the summary or save it out for sharing.

### Speaker review

If the app is uncertain about who spoke, a **Review speakers** panel appears near the top of the meeting page. Use it to match speaker labels to attendees, mark a speaker as unknown, or enter a custom display name. Speaker review is only prompted when labels are uncertain, and your mappings can improve transcript names and action item owners.

For more detail, see [Speaker Review and Diarization](./diarization-review.md).

---

## Troubleshooting

**"System audio was not captured" error**
Windows is probably holding exclusive control of your playback device. See the *Important Windows setting* in section 3.

**The meeting list is empty**
Check that you are signed in (top-left of the dashboard shows your initials). Click the **Refresh** link above the day strip. If still empty, open Settings and sign out / sign back in.

**Recording is live in the app but the tray menu says "Stop Recording" is greyed out**
Older versions had this sync bug. Update to the latest installer from your admin.

**Meetings show up on the wrong day**
This was a timezone bug fixed in the latest installer. Update if you are still seeing it.

**Nothing happens when I click Record**
Open the log file at
`%APPDATA%\meeting-notetaker-desktop\logs\main.log`
and send the last ~100 lines to your admin for diagnosis.

---

## Getting help

Send questions or bug reports to your internal admin, along with:

- What you were doing when the problem happened
- A screenshot if you have one
- The log file at `%APPDATA%\meeting-notetaker-desktop\logs\main.log`
