# Speaker mapping decision-card UX

## Goal
Make speaker mapping feel like a short review decision, not a technical mapping form. The UI should help the user decide who a detected audio cluster belongs to while avoiding false certainty when diarization is ambiguous.

## Problem
The current review card can show a person name such as `Joseph Miguel Guerrero` as the card title even when there is no saved mapping. It also says `Mapping for Joseph Miguel Guerrero`, which makes it look like the app already knows the speaker. The explanatory copy around the card is too dense and repeats the same idea in several places.

## Approved approach
Use a decision-card pattern:

- The outer meeting detail page should not show the extra sentence `Some speaker labels are uncertain...`.
- Each card should be titled neutrally: `Speaker 1`, `Speaker 2`, etc.
- The raw detected diarization label should be shown as a small secondary pill, e.g. `Detected label: SPEAKER_00`.
- The decision control should ask `Who said this?` instead of `Mapping for ...`.
- The dropdown keeps the same choices and saved payload behaviour: Unknown, attendees, and Custom name.
- Ambiguous cases still default to Unknown.
- Keep only concise helper text: quotes are evidence; choose a person only when the quote is clear.

## Scope
In scope:
- React component copy/layout changes in the speaker review panel.
- Meeting detail wrapper copy cleanup.
- Component tests for the new neutral card title and labels.
- Web targeted tests and build.

Out of scope:
- Backend diarization changes.
- New wizard flow.
- Release/version bump unless requested after verification.

## Verification
- SpeakerReviewPanel tests should prove:
  - speaker cards are titled neutrally (`Speaker 1`, `Speaker 2`), not attendee names;
  - detected raw labels remain visible;
  - `Who said this?` labels the selector;
  - Unknown remains the default for ambiguous mappings;
  - save payloads stay unchanged.
- Meeting detail test should no longer expect the removed explanatory sentence.
- Run targeted web tests and production build.
