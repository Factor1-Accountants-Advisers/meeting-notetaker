# Codex briefs — Slice 2 remaining code tasks (30 Jul 2026)

Four self-contained briefs for parallel Codex work on the personal PC. Common
rules for all four:

- **Base off `origin/main` at `73da18f` or later** (confirm the 30 Jul
  dead-screen-removal commit is present before starting — if the tip is still
  `b18cacb`, stop and ask Joseph to push).
- One branch per brief, `codex/<slug>` naming as before.
- Do NOT touch Jira. Do NOT push to `main` — deliver the branch; review,
  merge, and live verification happen on the work machine.
- Gates before handing back: `npm run typecheck`, `npm run build` (if renderer
  touched), backend `python -m unittest discover` from `backend/` (expect the
  known env-sensitive stub-concurrency flake — deterministic failure in some
  venvs, pre-existing on main, not yours to fix), `python -m compileall app`.
- Live Graph / Storage API / MSAL verification is out of scope everywhere —
  stub-level tests only. The work machine owns live retests.

---

## Brief A — IN-385: transcript + summary as separate SharePoint files

Branch: `codex/in-385-two-file-delivery`

Today `save_transcript_to_sharepoint` (backend/app/routers/meetings.py, ~line
634) writes ONE text file per meeting — transcript with summary and action
items embedded — to the InnovationsandSystems/Transcriptions library, with
IN-387 grant semantics. IN-385 (and acceptance test IN-398) require **two
separate files**: the transcript and the summary (summary file carries the
summary + action items).

Scope:
- Split the delivery into two uploads per meeting; keep naming consistent and
  collision-safe with the existing `Title-YYYY-MM-DD.txt` convention (e.g.
  `...-summary.txt` suffix — pick one convention and document it).
- IN-387 semantics are non-negotiable and apply to BOTH files: owner-implicit
  access + Graph `grant_view` invite (read, requireSignIn) atomic with upload;
  a partial grant (HTTP 200 with missing grantees) is a delivery failure.
- Both-or-nothing: if the second upload fails, the meeting's
  `sharepoint_status` must not report `saved`. Classify failures with the
  IN-391 taxonomy (`failure_reasons.py`).
- Local locked-folder stand-in (unconfigured drive) must mirror the two-file
  behaviour.
- Update `docs/pipeline-error-handling.md` and the jira-progress ledger entry.
- Tests: extend the existing sharepoint delivery tests; cover partial-grant on
  second file, second-upload failure, and stand-in mode.

Out of scope: real-library live cutover verification (IN-398 execution needs
two people and runs on the work machine).

---

## Brief B — IN-390: consolidate summarisation + action extraction into the structured output

Branch: `codex/in-390-output-consolidation`

NOTE: a brief for this was handed to Codex on 29 Jul — if a branch or draft
already exists from that, continue it rather than restarting.

Today summarisation and action-item extraction run as separate LLM calls with
separate outputs stitched downstream. IN-390 wants them consolidated into the
IN-384 structured JSON schema (single generation path, one schema-validated
object; `schema_version` bump if fields change — IN-397 asserts required
fields including `schema_version`).

Scope:
- Backend only (`backend/app/services/llm.py`, pipeline call sites, schema).
- Preserve the explicit unavailable-provider stub behaviour when OpenAI is not
  configured.
- Blob export (IN-386 envelope) and email/SharePoint rendering must consume
  the consolidated object — no behavioural change visible to recipients.
- Tests with the stub LLM provider; pin the schema shape.

---

## Brief C — review + land-or-drop `wip/in-386-delivery-hardening`

Branch: rebase `origin/wip/in-386-delivery-hardening` (c8948ba) onto current
main as `codex/in-386-hardening-landing`.

This is ~300 lines of UNREVIEWED, UNVERIFIED hardening parked from a deleted
worktree on 29 Jul (also briefed 29 Jul — check for prior progress):
- per-meeting blob-delivery task dedup (`_BLOB_DELIVERY_TASKS_BY_MEETING`) —
  may overlap failure vectors documented in the IN-478 post-mortem
  (kick_pipeline re-arm, POST /audio TOCTOU);
- WebM mime validation in `backend/app/schemas.py`;
- `HomeScreen.tsx` upload `accept=audio/webm` (small renderer touch);
- ~200 lines of tests.

Scope: per-hunk verdict (land / rework / drop with reason), reconcile with the
IN-391 taxonomy and IN-480 capture changes that landed after it was written,
deliver a clean branch where every kept hunk has a passing test. If the dedup
duplicates protection that IN-391's retry work already provides, dropping it
with a written rationale is a valid outcome.

---

## Brief D — IN-391 follow-ups: retention spec deviation + 401 taxonomy

Branch: `codex/in-391-followups`

Two small backend items recorded as open questions in the 29 Jul IN-391
verification sweep:

1. **Retention deletes failed-meeting audio.** `backend/app/services/
   retention.py` prunes recordings by file mtime alone, so a meeting stuck in
   a failed/retryable state loses its retry audio on the same 30-day clock.
   The IN-391 spec said audio should only age out after the meeting reaches
   `ready` (or a terminal delivered state). Gate deletion on meeting status;
   keep the 30-day clock for delivered/ready meetings; decide and document
   behaviour for permanently-failed meetings (suggest: keep until failure is
   terminal + 30 days, then delete).
2. **pyannoteAI 401 misclassification.** A provider auth failure currently
   classifies as `azure_signin` ("Microsoft sign-in") in `failure_reasons.py`
   — misleading for operators. Introduce/route to a provider-credential
   category with an accurate fixed sentence. Update
   `docs/pipeline-error-handling.md`, the renderer label passthrough (labels
   are data-driven — confirm no renderer change needed), and tests pinning
   the classification.

---

Handback format (all briefs): branch pushed to origin, summary of what
changed + verdicts/decisions taken, gate output, and anything discovered that
belongs in the jira-progress ledger.
