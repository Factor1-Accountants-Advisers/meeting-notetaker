# Codex briefs — batch 2 (30 Jul 2026, work Codex)

Common rules (same as batch 1, plus a collision guard):

- **Base off `origin/main` at `c0de145` or later** — if the tip is older, stop
  and ask Joseph to push.
- One branch per brief, `codex/<slug>`. No Jira writes, no pushes to `main`,
  no live Graph/Storage/MSAL calls — stub-level verification only.
- Gates: backend `python -m unittest discover` (run with `backend/.env`
  MOVED ASIDE if one exists — ~20 tests assume stub defaults; restore after),
  `python -m compileall app`, `npm run typecheck`, `npm run build` if renderer
  or main-process code is touched, `git diff --check`.
- **Do NOT touch** `.github/workflows/release.yml`, `electron-builder*.yml`,
  or any auto-update/updater code — IN-469 is being built in parallel on the
  work machine and owns those files. Conflicts there will get your branch
  rebased or dropped.
- Handback: branch pushed, summary of changes + decisions, gate output,
  ledger-worthy discoveries.

---

## Brief E — land-or-drop review of `wip/in-386-delivery-hardening`

Execute **Brief C of `2026-07-30-codex-briefs-slice2.md` exactly as written
there** (rebase `origin/wip/in-386-delivery-hardening` c8948ba onto current
main as `codex/in-386-hardening-landing`; per-hunk land/rework/drop verdicts;
every kept hunk needs a passing test). That brief was never executed — a
prior agent delivered a general security audit instead. The security audit is
done and triaged; do not repeat it. Note the parked branch predates the
IN-391 taxonomy, the IN-480 capture changes, AND today's IN-385/IN-390
merges — reconcile against all of them.

## Brief F — encrypt the persisted MSAL token cache

Branch: `codex/msal-cache-safestorage`

`src/main/auth-msal.ts` (`persistTokenCache`, ~line 74) writes the serialized
MSAL cache to disk in plaintext; it holds refresh tokens for Mail.Send,
SharePoint, and the Storage API. Migrate to Electron `safeStorage`
(DPAPI-backed on Windows):

- Encrypt on persist (`safeStorage.encryptString`), decrypt on load. Store as
  a binary/base64 file distinct from the legacy plaintext file name so the
  format is self-evident.
- One-time migration: on load, if only the legacy plaintext cache exists,
  read it, re-persist encrypted, and delete the plaintext file. A corrupt or
  undecryptable cache must degrade to signed-out (delete + return null),
  never crash startup.
- Guard `safeStorage.isEncryptionAvailable()` — if unavailable, log a warning
  and fall back to the current behaviour rather than bricking sign-in (this
  app is Windows-only; DPAPI should always be available, but fail open on
  auth availability, not closed).
- Sign-out must clear both file forms.
- Add a `verify:*` script (esbuild pattern like `verify:backend-supervisor`)
  covering: encrypt/decrypt round-trip, legacy migration, corrupt-cache
  fallback, sign-out clearing. Wire nothing into CI beyond the script.
- Main-process change — note in the handback that a full dev restart is
  needed to test manually (renderer HMR is not enough).

## Brief G — IN-383: company context file enriches summaries

Branch: `codex/in-383-context-file`

IN-383 (Planned) + acceptance test IN-400: a company context file on
SharePoint should enrich meeting summaries. Design-then-implement, stub-first:

- **Provider seam** like the existing SharePoint/LLM patterns: a context
  provider that returns the context text or None. Local stand-in mode reads
  `backend/var/context/company-context.md` (create the dir convention, not
  the file); the Graph-backed mode fetches a configured drive item
  (`MN_CONTEXT_DRIVE_ID` + `MN_CONTEXT_FILE_PATH`, both empty by default =
  stand-in mode) using the existing delegated `X-MN-Graph-Token` header
  pattern. Live Graph verification is out of scope — work machine.
- **Injection point:** the consolidated IN-390 generation path in
  `backend/app/services/llm.py` (single `StructuredMeetingOutput` generation
  — do not resurrect per-section calls). Context goes into the system/prompt
  side, clearly delimited, with a hard character cap (suggest ~8k chars,
  truncate with a logged warning) so a runaway context file can't starve the
  transcript out of the window.
- **Failure semantics:** context is an enrichment, never a gate — fetch
  failure or absence logs one structured line and proceeds without it. No new
  failure categories.
- Cache the fetched context per pipeline run (not per chunk) so map/reduce
  long meetings don't refetch.
- Tests: stub provider with/without context, cap/truncation, fetch-failure
  proceeds, and a pinned prompt-shape test proving the context block is
  present and delimited when supplied.
- Document the two env vars in `backend/.env.example` and the ledger.

---

Suggested merge order back on the work machine: F (isolated), then E, then G
(G touches llm.py which E's parked hunks do not, but E may land schema tests).
