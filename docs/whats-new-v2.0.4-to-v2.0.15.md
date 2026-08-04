# Notetaker — What's New, v2.0.4 → v2.0.15

Raw material for the two SharePoint handover docs
(`30 - J000039 - The Notetaker/05 — Handover and Closure`). CONSUMED 4 Aug
2026: rewritten as `Notetaker V2.0.15 - Projects Handover.docx` and
`- IT Handover.docx` (originals kept alongside). Kept for the record.

Additions since this file was first drafted:
- v2.0.14 (3 Aug): SharePoint delivery no longer fails when one attendee
  can't be granted access — per-recipient grants, ungranted people listed in
  the delivery notice.
- v2.0.15 (4 Aug): OpenAI + pyannote API keys rotated (DV request); no
  user-visible change. Establishes the rotation runbook: GitHub secrets →
  patch release → fleet auto-update → revoke old keys.

## For end users (Projects Handover, "User guide" section)

**Getting the app / staying current**
- The app now updates itself. Install once and it silently keeps itself
  current (a toast asks to restart when an update is ready; "Later" defers,
  and updates never interrupt an active recording). Nobody downloads
  installers from SharePoint anymore.
- Until IT's certificate rollout reaches your machine, the first install may
  show a "Windows protected your PC" prompt (More info → Run anyway). This
  disappears once IT pushes the trust certificate via Intune.

**First-run: voiceprint enrolment (new, required)**
- On first sign-in the app requires a short voice enrolment: consent, then
  three read-aloud samples. Voiceprints are stored centrally and securely, so
  any Factor1 Notetaker can identify you in transcripts; original recordings
  are deleted after the voiceprint is created.
- You enrol once, on any machine. If the app ever asks you to enrol again and
  you already have, don't — check your connection and Microsoft sign-in, then
  use Try again (offline sessions can't verify enrolment).

**Recording**
- Scheduled Teams meetings you organise auto-record: the app watches your
  calendar and starts recording about a minute into the meeting — no action
  needed. Manual recording remains for ad-hoc/in-room meetings.
- A tray menu (bottom-right) now offers Pause / Resume / Stop and "Extend 10
  minutes" while recording; a toast reminds you 5 minutes before the scheduled
  end, with Extend right on the notification.
- Live audio meters and silence warnings tell you immediately if your mic or
  system audio has gone quiet.
- Switching audio devices mid-meeting (e.g. connecting Bluetooth earphones) is
  now handled — the recording follows your new microphone and speakers
  automatically.
- Interrupted recordings (crash, sleep, forced restart) are recovered and
  offered for upload on the next launch.

**After the meeting**
- Notes are emailed to all attendees automatically (one email; a retry never
  double-sends).
- Two files are saved to the SharePoint Transcriptions library:
  `YYYY-MM-DD Title - Transcript.md` and `- Summary.md`, at the top level of
  the library. Attendees are granted view access automatically; if someone
  can't be granted (external guests, distribution lists) the files still save
  and the app tells you who to share with manually.
- Failures are labelled plainly (e.g. "Failed: Microsoft sign-in") with a
  Retry that resumes only the step that failed.

**Speaker identification**
- Transcripts name enrolled Factor1 speakers automatically via central
  voiceprints; unknown voices are labelled Speaker 1/2/… and can be named
  during review.
- Admins have a Voiceprint Admin screen (visible only with the admin role) to
  list/disable/re-enable voiceprints.

## For IT / Projects (IT Handover — largely superseded by DV's 3 Aug
"Application Deployment process for Factor 1" email + attached guide)

- Distribution: SharePoint folder is retired. Signed installer comes off the
  update feed (`stf1nt` public updates container); IT packages that exe for
  Intune (IntuneWinAppUtil, silent switch `/S`). After first install the app
  self-updates from the feed — IT deploys once per machine, not per release.
- Signing: every release is signed in CI via Azure Artifact Signing
  (Private Trust, `CN=factor1.com.au`); devices need the "Microsoft Enterprise
  Identity Verification Root CA 2020" pushed via an Intune Trusted certificate
  profile. Verify with `Get-AuthenticodeSignature`.
- Install/uninstall now kill any orphaned backend process automatically (the
  2.0.6 "uninstall blocked by running process" issue is fixed).
- Backend data/credentials ship inside the app; meeting audio, voiceprints and
  records live in the central Azure storage platform behind an authenticated
  Storage API — nothing sensitive is exposed by the update feed.
