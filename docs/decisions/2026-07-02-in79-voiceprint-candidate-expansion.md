# IN-79 — Voiceprint candidate expansion rules

Date: 2026-07-02
Status: Accepted for Slice 1

## Context

IN-79 asks for voiceprint candidate selection beyond the meeting invite list for approved key people who may appear uninvited. The related false-positive requirement (IN-80) means we must avoid broad staff-gallery matching and must keep non-attendee matching conservative.

## Decision

Use a two-pass pyannoteAI identify flow:

1. First pass: submit only listed meeting attendees, organiser, and recorder/owner voiceprints.
2. If all speakers are identified, stop.
3. If speakers remain Unknown, run a second pass with the first-pass candidates plus a configured, capped key-person expansion list.
4. Apply a stricter confidence threshold to second-pass expansion matches.
5. Never run broad all-staff identification by default.

## Configuration

Environment variables:

- `MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS` — comma-separated employee IDs/emails in priority order, e.g. `df@factor1.com.au,tc@factor1.com.au`.
- `MN_VOICEPRINT_EXPANSION_CAP` — maximum number of configured expansion candidates to add; default `5`.
- `MN_VOICEPRINT_EXPANSION_MIN_CONFIDENCE` — stricter second-pass threshold; default `0.85`.

## Rationale

This preserves the attendee-first behaviour used by Microsoft Teams-style attribution while allowing approved key people to be resolved when they were not invited. The cap and stricter threshold limit false positives, and the explicit configuration makes the expansion list auditable.

## Verification

Unit tests cover attendee-first ordering, configured priority order, expansion cap enforcement, and config parsing. Existing tests continue to cover low-confidence and insufficient-overlap suppression.
