# Notetaker handovers — V2.0.43 review copy

Local review copy for the 2.0.43 release (FD-2265). Not published.

| File | Audience |
|---|---|
| `Notetaker V2.0.43 - IT Handover.md` | IT / Infrastructure |
| `Notetaker V2.0.43 - Projects Handover.md` | Projects (rollout, training, comms) |

## Source

Each guide starts from the **published V2.0.15 copy** in SharePoint (`InnovationsandSystems › 30 - J000039 - The Notetaker › 05 — Handover and Closure`), read on 16 Nov 2026. The OneDrive Desktop copies (`Notetaker Handover V2.0.15`) are older and were not used.

Scope agreed with Joseph: the FD-2265 changes, plus facts that are wrong today and can be checked in the code. Every other difference from the current app is listed under "Not changed" below. Screenshots stay as in the published copy; this release adds none.

## What changed from V2.0.15

**IT Handover**

- §8.2: the "asked to re-enrol" row is replaced by four rows: **Sign in again**, Sign in again + "still can't reach the voiceprint service", **Couldn't check your voiceprint**, **Voiceprint required**. Each row quotes the exact `main.log` line.
- §8.2 "Sign-in fails or loops": names `msal-cache.bin` (and a leftover `msal-cache.json`).
- §3 token cache row and §6.1: `msal-cache.bin`, DPAPI-encrypted since v2.0.8. An undecryptable cache is cleared; **Sign out** clears it. The V2.0.15 text said plaintext `msal-cache.json`.
- §2.1: new bullet. The backend moves to IPv4 within 3 seconds when the IPv6 route to the Storage API is unusable, and a voiceprint check answers within 10 seconds.
- §2.2 and §6.1: the `notetaker-audio-endpoints.exe` process (audio device monitor, `resources\audio`).
- §3.1, §6.3, §8.1: Notetaker checks the voiceprint before the Home screen opens.
- Cover: 2.0.17 → 2.0.43. §8.1: 2.0.15 → 2.0.43. New §11 version history.

**Projects Handover**

- §2.2: step 4 (**Checking your voiceprint**), then what to do on **Sign in again**.
- §2.3: the "if the app asks you to enrol again" note is replaced by a short table of the three screens.
- §5.3: "Your voiceprint is safe" training message; duplicated "The app updates itself" bullet removed.
- §5.2: steps renumbered 1–6 (V2.0.15 started at 3).
- Spelling: "complaince", "attent", "outlook", stray space in "manual recording".
- Cover and companion-document name: 2.0.43. New §7 version history.

Facts checked against the code on `fix/FD-2265-sign-in-gate`: Entra client and tenant IDs, Storage API host and scope, Graph scopes, port 8787, update feed and 4-hour check, token cache file and DPAPI codec, on-screen text of every gate screen, log lines quoted in §8.2, audio monitor executable.

## Not changed — drift found for a later version

**IT Handover**

1. §4.2 says "No .intunewin package has been produced yet — scheduled after code signing". Signing has been live since 31 Jul 2026; Intune has deployed the app since 3 Aug.
2. §9 "Open items before broad rollout" keeps an open item (AI account transfer "still being finalised") — breaks the no-open-items rule; needs an owner's current status.
3. No monitoring section (manifesto §11).
4. The Teams call prompt for unscheduled Teams calls (v2.0.42, FD-97) is not described, nor its release-build switch.
5. On networks where the IPv6 route to the Storage API fails, the People list's central directory lookup (5-second limit) still falls back to the local list. Seen in the 16 Nov test; separate from the voiceprint check.
6. Formatting carried over: stray "(section 5)." in §2.1; Contacts "IT (IN prior to handover)".

**Projects Handover**

1. §3 "Key limitations — what the tool does not do" breaks the house rule against negative scope, and carries forward promises ("planned for future release", "coming in later release").
2. §1 says notes go "to the meeting host by email"; §1.1 and §2.8 say one email to all attendees.
3. §2.8 says unknown speakers can be named during review; §3 says there is no way to rename speakers.
4. §1.2 says auto-recording starts "within about 3 minutes" of the start; the IT guide says "about 1–2 minutes before/into".
5. §4 says "SharePoint once enabled"; SharePoint saving is live (§1.1, §2.8).
6. §6 "Ideas Portal [insert link]" is an unfilled placeholder.
7. The Teams call prompt (v2.0.42) is not described for users.
8. Cover "Status" still says screenshots will be re-captured for the training pack.

## Next steps

1. Joseph reviews both files.
2. The agreed text goes into Word on top of the **published** V2.0.15 `.docx` (download from the library), saved as `Notetaker V2.0.43 - IT Handover.docx` / `… Projects Handover.docx`, keeping the V2.0.15 files.
3. Publishing to SharePoint `05 — Handover and Closure` (and archiving V2.0.15) needs Joseph's approval.
