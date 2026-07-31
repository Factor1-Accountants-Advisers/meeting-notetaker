# IN-389 — Transcript ↔ speaker-identity merge approach

Status: implemented (this document ratifies the shipped behaviour and is the
authoritative definition the ticket asked for). Code anchors are given per
section; tests pin the numbers.

## Inputs

- **Transcript segments** are *turn-level*, not word-level: pyannoteAI's
  `turnLevelTranscription` output (fallback: `diarization` /
  `exclusiveDiarization`), built in `app/services/speech.py`. Each segment
  arrives with a raw diarization cluster label (`SPEAKER_00`), millisecond
  timestamps, and no identity. Provider ASR confidence is not consumed.
- **Identity ranges** come from pyannoteAI voiceprint identification
  (`confidence: True`, `exclusive: True`), parsed in
  `app/services/speaker_matching.py` (`_identify_ranges`): seconds→ms,
  zero/negative-length ranges dropped, confidence normalised to 0–1 from the
  per-match value or the per-raw-speaker `voiceprints[].confidence` map.

## Merge algorithm (base pass)

Implemented in `_apply_identity_ranges` / `_best_range_for_segment`
(`app/services/speaker_matching.py`). For each segment, a candidate identity
range must pass three gates:

| Gate | Rule | Value |
|---|---|---|
| Raw-cluster match | range's `raw_speaker` equals the segment's raw cluster (empty = wildcard) | — |
| Overlap | `min(ends) − max(starts)` | ≥ `MIN_OVERLAP_MS = 800` |
| Confidence | range confidence vs threshold; `None` confidence passes ungated | ≥ `similarity_threshold = 0.62` |

The winning range is the one with the **largest overlap**; the segment gets
the identity's display name, `speaker_known=True`,
`speaker_source="pyannote_voiceprint"`, `speaker_confidence`, and the
evidence window (`speaker_evidence_start_ms`/`_end_ms`/`_job_id`).

## Second passes

1. **Controlled expansion (IN-79)** — only when base-pass unknowns remain and
   `MN_VOICEPRINT_EXPANSION_EMPLOYEE_IDS` is configured: a second identify
   call over the expansion candidates, accepted only at the stricter
   `voiceprint_expansion_min_confidence = 0.85`, applied only to
   still-unknown segments, `speaker_source="pyannote_voiceprint_expansion"`.
   Matches re-merge by segment identity key `(raw_speaker, start_ms, end_ms,
   text)` — never by cluster.
2. **Cluster propagation (IN-86)** — if a raw cluster carries exactly one
   known identity, is unambiguous, and that identity already covers ≥
   `CLUSTER_PROPAGATE_MIN_FRACTION = 0.5` of the cluster's speech duration,
   the name spreads to the cluster's remaining unmatched segments with
   `speaker_source="cluster_propagation"` and evidence copied from the
   exemplar segment. Ambiguous clusters stay Unknown.

## Uncertain segments — never guessed

Segments failing the gates keep `speaker_known=False`, a per-cluster
`Speaker N` label (renumbered without gaps after propagation absorbs
clusters), and a machine-readable `unknown_reason`:

- Per-segment: `low_confidence`, `insufficient_overlap`, `no_identity_match`.
- Whole-run: `no_voiceprint_identification`, `no_enrolled_voiceprints`,
  `pyannote_api_key_missing`, `no_candidate_voiceprints`,
  `no_identity_ranges`.

Downstream, action items owned by unknown speakers have
owner/email/confidence/source/assignment fields nulled in the pipeline.

## speaker_source taxonomy (complete)

| Value | Meaning |
|---|---|
| `pyannote_voiceprint` | base identify pass, ≥ 0.62 |
| `pyannote_voiceprint_expansion` | IN-79 expansion pass, ≥ 0.85 |
| `cluster_propagation` | IN-86 single-identity cluster spread |
| `user_corrected` | manual naming via `POST /meetings/{id}/name-speaker` — set 31 Jul 2026; clears `speaker_confidence` and `unknown_reason` |
| `unknown` | no gate passed |

## JSON schema surface

`TranscriptSegment` (`app/schemas.py`) carries the full provenance:
`speaker`, `speaker_known`, `raw_speaker`, `speaker_source`,
`speaker_confidence`, `speaker_evidence_*`, `unknown_reason`. The canonical
export (`app/services/meeting_export.py`, `ExportTranscriptSegment`) exposes
`speaker`, `text`, `start`, `end`, `confidence` (identity confidence, not
ASR), `speaker_source` — the fields the IN-389 ticket requires. Unknowns are
detectable by `speaker_source == "unknown"`.

## Word-level note

The ticket says "word-level"; the shipped pipeline merges at turn level
because that is what the provider returns for this configuration. Overlap
gating at 800 ms plus turn-level ranges has held up in live meetings
(IN-86 retest pending). If word-level timestamps become available, the same
three-gate merge applies per word with a smaller `MIN_OVERLAP_MS`.

## Tests

`backend/tests/test_speaker_identity_matching.py` (gates, expansion,
propagation, renumbering), `backend/tests/test_meeting_export.py`
(`user_corrected` provenance, export field pin).
