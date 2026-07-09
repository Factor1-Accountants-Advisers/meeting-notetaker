# Diarization of remote speakers — scoping note (IN-86)

Date: 2026-07-09
Status: For decision (Joseph + David)

## The problem

IN-86 ("known speaker identified by voiceprint with high confidence") failed on
a real Teams meeting (pyannote job `39336e51-c56e-44ef-8588-1abad8d6939c`):
the transcript did **not separate speakers** — most conversation came back in
huge chunks, and BB/DA were not distinguished, even though earlier tests
separated them fine. Re-uploading the same audio reproduced it.

## What is and isn't the cause

- **When a speaker matches, confidence is high** (0.86–0.90, well above the 0.80
  bar). So this is not a low-confidence-score problem.
- The failure is **upstream of voiceprints**: pyannote **diarization** (who
  spoke when) produced coarse chunks. Voiceprint identification can only label
  the clusters diarization gives it — it cannot fix bad clusters. So David's
  hypothesis (voiceprint-count asymmetry) does not explain the chunking;
  diarization never sees the voiceprints.

## Root cause: we capture a pre-mixed Teams downlink

Capture architecture: we record the **recorder's mic** + the **system loopback**
and merge them into one mono stream for pyannote (`_merge_mic_and_system_audio`,
`amix=inputs=2`).

In a Teams call the system loopback is a **single pre-mixed downlink** — Teams
blends every remote participant into one audio stream before it is played (and
therefore before we capture it). So when BB and DA are both remote, their voices
arrive **already mixed in one channel**, and pyannote is asked to un-mix two
voices that were mixed upstream. That is inherently hard and yields coarse
chunks.

It is made worse by the recurring **P0 mic-silence** issue: when the recorder's
mic records silence (Bluetooth/exclusive-mode), the *entire* recording is the
pre-mixed downlink with nothing else to separate on.

"Separable in initial tests" was most likely because those tests were in-person
(spatially distinct mics) rather than a single Teams downlink.

## What we shipped now (cheap, safe)

1. **Propagation guard** (`speaker_matching.py`): cluster-identity propagation
   only fires when the matched identity already covers a **majority** of a
   cluster's speech. This prevents spreading one name across an under-separated
   blended chunk (which would mislabel the other speaker — violating
   Unknown-over-wrong-name).
2. **Speaker-count hint** (`MN_PYANNOTE_NUM_SPEAKERS`, default 0/off): passes
   pyannote `numSpeakers` when set. Deliberately a manual knob, **not**
   auto-derived from Graph attendees — attendees ≠ speakers, and a silent
   recorder mic makes the attendee count over-estimate audible speakers, which
   would degrade currently-working meetings.

Neither of these can un-mix a pre-mixed downlink; they reduce collateral damage
and give a tuning knob.

## The real fix — needs a decision (likely a later slice)

Reliably separating multiple **remote** participants from a single pre-mixed
Teams downlink is not achievable by tuning diarization. Options, roughly in
order of effort:

1. **Per-participant audio.** Teams does not readily expose separate
   per-speaker streams to a desktop capture app; this likely needs the Teams
   meeting/bot APIs, not loopback capture.
2. **Use Teams' own transcript / attendee-timing** for speaker attribution and
   use pyannote only for the recorder's own mic. Best accuracy for online
   meetings; real integration work.
3. **Scope online-meeting speaker separation as best-effort** for Slice 1 and
   set expectations: the recorder is identified from their own mic; remote
   speakers may be grouped when Teams pre-mixes them. In-person meetings (true
   multi-mic audio) separate normally.

## Recommendation

Do not mark IN-86 Passed. Ship the two safe changes above, retest at the sync
with `MN_PYANNOTE_NUM_SPEAKERS` set to the known count for a controlled trial,
and make an explicit slice decision between options 1–3 for robust online
speaker separation.
