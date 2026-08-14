# Call Watches Per Meeting (Registered at Discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the Graph call watch for every eligible auto-record meeting at calendar discovery (not at recording start), one watch per meeting, so leave-detection works regardless of when participants join and across back-to-back meeting chains.

**Architecture:** Root cause (confirmed live 13–14 Aug): a Graph `meetingCallEvents` subscription never fires for a call that was already live when the subscription was created. Fix per spec `docs/superpowers/specs/2026-08-14-call-watch-per-meeting-design.md` (decisions E1–E6 govern every task; parent spec `2026-08-12-meeting-call-events-design.md` D1/D3–D9 still stand): storage-api keys watches by `(oid, join_url_hash)` with legacy `current/*` aliases for the v2.0.25 fleet; the desktop gains a **watch registrar** driven by the calendar poller, and `armCallSignals` becomes an *attach* (baseline-drain stale signals, then poll) with today's register-at-start as fallback. The state machine (`call-signals-core.ts` machine section) is untouched.

**Tech Stack:** Python 3.11 + FastAPI (storage-api, pytest; local backend, pytest); Electron main TypeScript (desktop; esbuild `verify:*` harnesses — this repo has no vitest).

**Repos:** Tasks 1–4 in `C:\Projects\notetaker-storage-api` (own git). Tasks 5–10 in `C:\Projects\meeting-notetaker-2`. Commit in the repo you edited. Both repos: work on branch `feature/call-watch-per-meeting`.

**Pre-flight check (once, before Task 1):** the store must hold no live watches at deploy time (there is no old→new layout migration; orphans self-expire per D3). Verify:
`az storage blob list --account-name stf1nt --container-name notetaker --prefix "callwatches/" --auth-mode login -o table` — only zero-byte directory markers may remain.

---

## Phase 1 — storage-api (`C:\Projects\notetaker-storage-api`)

### Task 1: Per-meeting watch store

**Files:**
- Modify: `app/services/call_watches.py`
- Modify: `app/routers/graph_webhook.py:227-237` (`_process_item` signal append)
- Test: `tests/test_call_watch_store.py` (extend), `tests/test_graph_webhook.py` (fix layout expectations)

The store moves from `callwatches/{oid}/watch.json` to
`callwatches/{oid}/{join_url_hash}/watch.json` (+ that meeting's
`signals/{seq}.json` beside it). Generation stamping (`subscription_id`
filter at read) is unchanged — it is the correctness mechanism and stays.

- [ ] **Step 1: Write the failing tests** (extend `tests/test_call_watch_store.py`, following its existing fake-blob fixture style):

```python
HASH_A = "a" * 64
HASH_B = "b" * 64


def test_watches_for_two_meetings_coexist(store):
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_A,
                               subscription_id="sub-a", subscription_expires_utc="2026-08-15T00:00:00Z")
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_B,
                               subscription_id="sub-b", subscription_expires_utc="2026-08-15T01:00:00Z")
    watches = call_watches.list_watches("oid1")
    assert {w["join_web_url_hash"] for w in watches} == {HASH_A, HASH_B}


def test_replace_same_meeting_returns_prior_and_keeps_other(store):
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_A, subscription_id="sub-a1",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_B, subscription_id="sub-b",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    prior = call_watches.replace_watch("oid1", join_web_url_hash=HASH_A, subscription_id="sub-a2",
                                       subscription_expires_utc="2026-08-16T00:00:00Z")
    assert prior["subscription_id"] == "sub-a1"
    assert len(call_watches.list_watches("oid1")) == 2


def test_signals_are_scoped_to_their_meeting(store, frozen_now):
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_A, subscription_id="sub-a",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_B, subscription_id="sub-b",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    call_watches.append_signal("oid1", HASH_A, {"type": "recorder_left", "event_utc": None},
                               subscription_id="sub-a", notification_id="n1", received_utc=frozen_now)
    assert [s["type"] for s in call_watches.list_signals("oid1", HASH_A)] == ["recorder_left"]
    assert call_watches.list_signals("oid1", HASH_B) == []


def test_delete_watch_removes_only_that_meeting(store):
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_A, subscription_id="sub-a",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_B, subscription_id="sub-b",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    deleted = call_watches.delete_watch("oid1", HASH_A)
    assert deleted["subscription_id"] == "sub-a"
    assert [w["join_web_url_hash"] for w in call_watches.list_watches("oid1")] == [HASH_B]


def test_find_watch_by_subscription_sees_nested_layout(store):
    call_watches.replace_watch("oid1", join_web_url_hash=HASH_A, subscription_id="sub-a",
                               subscription_expires_utc="2026-08-15T00:00:00Z")
    found = call_watches.find_watch_by_subscription("sub-a")
    assert found["join_web_url_hash"] == HASH_A
```

- [ ] **Step 2: Run to verify failure**: `python -m pytest tests/test_call_watch_store.py -q` — FAIL (`list_watches` undefined; `append_signal` signature).

- [ ] **Step 3: Implement.** In `app/services/call_watches.py`:
  - Path helpers become per-meeting: `_watch_dir(oid, h) = f"callwatches/{oid}/{h}/"`, `_watch_blob(oid, h)`, `_signals_prefix(oid, h)`.
  - `replace_watch(oid, *, join_web_url_hash, subscription_id, subscription_expires_utc)`: same body as today but against the per-meeting paths — prior lookup, `delete_prefix` of that meeting's signals, write record. Returns prior for that meeting only.
  - `append_signal(oid, join_web_url_hash, signal, *, subscription_id, notification_id, received_utc)` and `list_signals(oid, join_web_url_hash)`: same logic against per-meeting paths.
  - `get_watch(oid, join_web_url_hash)`, `delete_watch(oid, join_web_url_hash)` (deletes `_watch_dir(oid, h)`).
  - New `list_watches(oid) -> list[dict]`: `blob.list_json_prefix(container, f"callwatches/{oid}/", name_suffix="/watch.json")`, return the decoded records.
  - `find_watch_by_subscription`: **unchanged** — the `/watch.json` suffix filter already matches the nested layout.
  - Update the module docstring (spec E2 supersedes D2's layout).
  - In `graph_webhook.py::_process_item`, the append becomes
    `call_watches.append_signal(watch["oid"], watch["join_web_url_hash"], signal, subscription_id=..., notification_id=..., received_utc=...)`.

- [ ] **Step 4: Run**: `python -m pytest tests/test_call_watch_store.py tests/test_graph_webhook.py -q` — PASS (fix any webhook-test layout assertions to the nested paths).

- [ ] **Step 5: Commit**: `git checkout -b feature/call-watch-per-meeting && git add -A && git commit -m "feat: per-meeting call-watch store (spec E2)"`

### Task 2: Per-meeting routes + watch cap

**Files:**
- Modify: `app/routers/call_watches.py`
- Modify: `app/models.py` (no new models needed; hash validated in-route)
- Test: `tests/test_call_watch_routes.py` (extend)

- [ ] **Step 1: Failing tests.** NOTE: snippets below use shorthand fixtures — adapt to the file's REAL machinery: `enabled_settings` / `make_token` fixtures and the `_post_watch(client, headers, subscription=...)` helper (Graph is mock-patched per call; there is no `fake_graph` fixture, and `TEST_OID` is whatever oid `make_token` mints). Pytest fails loudly on unknown fixtures, so any drift is caught at Step 2:

```python
HASH_RE_BAD = "not-a-hash"


def test_create_two_watches_and_read_each(client_authed, fake_graph):
    r1 = client_authed.post("/api/v1/call-watches",
                            json={"join_web_url": "https://teams.microsoft.com/a",
                                  "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    r2 = client_authed.post("/api/v1/call-watches",
                            json={"join_web_url": "https://teams.microsoft.com/b",
                                  "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    assert r1.status_code == 200 and r2.status_code == 200
    h1 = hashlib.sha256(b"https://teams.microsoft.com/a").hexdigest()
    assert client_authed.get(f"/api/v1/call-watches/{h1}/signals").json() == {"signals": []}


def test_watch_cap_returns_409(client_authed, fake_graph):
    for i in range(5):
        assert client_authed.post("/api/v1/call-watches",
                                  json={"join_web_url": f"https://teams.microsoft.com/{i}",
                                        "scheduled_end_utc": "2026-08-15T00:00:00Z"}).status_code == 200
    r = client_authed.post("/api/v1/call-watches",
                           json={"join_web_url": "https://teams.microsoft.com/overflow",
                                 "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    assert r.status_code == 409
    assert r.json()["error"] == "watch_limit"


def test_cap_still_allows_replacing_existing_meeting(client_authed, fake_graph):
    for i in range(5):
        client_authed.post("/api/v1/call-watches",
                           json={"join_web_url": f"https://teams.microsoft.com/{i}",
                                 "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    r = client_authed.post("/api/v1/call-watches",
                           json={"join_web_url": "https://teams.microsoft.com/0",
                                 "scheduled_end_utc": "2026-08-16T00:00:00Z"})
    assert r.status_code == 200


def test_malformed_hash_is_422(client_authed):
    assert client_authed.get(f"/api/v1/call-watches/{HASH_RE_BAD}/signals").status_code == 422
    assert client_authed.delete(f"/api/v1/call-watches/{HASH_RE_BAD}").status_code == 422


def test_delete_by_hash_is_204_and_idempotent(client_authed, fake_graph):
    client_authed.post("/api/v1/call-watches",
                       json={"join_web_url": "https://teams.microsoft.com/a",
                             "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    h = hashlib.sha256(b"https://teams.microsoft.com/a").hexdigest()
    assert client_authed.delete(f"/api/v1/call-watches/{h}").status_code == 204
    assert client_authed.delete(f"/api/v1/call-watches/{h}").status_code == 204
```

- [ ] **Step 2: Run to verify failure**: `python -m pytest tests/test_call_watch_routes.py -q`

- [ ] **Step 3: Implement** in `app/routers/call_watches.py`:

```python
_MAX_WATCHES_PER_USER = 5  # spec E3
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def _require_valid_hash(join_url_hash: str) -> None:
    if not _HASH_RE.fullmatch(join_url_hash):
        raise ApiError(422, "validation_error", "join_url_hash must be 64 lowercase hex chars")
```

  - `create_call_watch`: after `_require_enabled()`, compute the hash FIRST, then enforce the cap **before** touching Graph (never create a subscription we would refuse to store):
    `existing = call_watches.list_watches(principal.oid)`;
    if `join_web_url_hash` not among `existing` and `len(existing) >= _MAX_WATCHES_PER_USER` → `raise ApiError(409, "watch_limit", "call watch limit reached")`.
    Then the current Graph-create/replace/audit flow, passing `join_web_url_hash` through to the per-meeting `replace_watch`.
  - `GET /call-watches/{join_url_hash}/signals` and `DELETE /call-watches/{join_url_hash}`: `_require_enabled()`, `_require_valid_hash(...)`, then per-meeting store calls (delete also does the best-effort subscription delete + audit, as today). **Declare the legacy `current` routes (Task 3) BEFORE the `{join_url_hash}` routes** so path matching never captures the literal `current`.

- [ ] **Step 4: Run**: `python -m pytest tests/test_call_watch_routes.py -q` — PASS. Also `python -m pytest -q` (full suite; the known flaky `test_stub_serializes_concurrent_exports_for_one_meeting` may fail — rerun-once policy applies, it is unrelated).

- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat: per-meeting call-watch routes with 5-watch cap (spec E3)"`

### Task 3: Legacy fleet aliases

**Files:**
- Modify: `app/routers/call_watches.py`
- Test: `tests/test_call_watch_routes.py` (extend)

v2.0.25 clients call `GET /call-watches/current/signals` and
`DELETE /call-watches/current`. Their semantics under per-meeting storage
(spec E6): signals = union across the caller's watches (each filtered by its
own generation, sorted by `seq`); delete = delete all the caller's watches.
Correct for a one-meeting-at-a-time old client.

- [ ] **Step 1: Failing tests**:

```python
def test_legacy_current_signals_unions_all_watches(client_authed, fake_graph, frozen_now):
    for u in ("https://teams.microsoft.com/a", "https://teams.microsoft.com/b"):
        client_authed.post("/api/v1/call-watches",
                           json={"join_web_url": u, "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    # append one signal per watch via the store, stamped with each watch's live subscription id
    for w in call_watches.list_watches(TEST_OID):
        call_watches.append_signal(TEST_OID, w["join_web_url_hash"],
                                   {"type": "recorder_left", "event_utc": None},
                                   subscription_id=w["subscription_id"],
                                   notification_id=None, received_utc=frozen_now)
    body = client_authed.get("/api/v1/call-watches/current/signals").json()
    assert len(body["signals"]) == 2


def test_legacy_current_delete_removes_all(client_authed, fake_graph):
    for u in ("https://teams.microsoft.com/a", "https://teams.microsoft.com/b"):
        client_authed.post("/api/v1/call-watches",
                           json={"join_web_url": u, "scheduled_end_utc": "2026-08-15T00:00:00Z"})
    assert client_authed.delete("/api/v1/call-watches/current").status_code == 204
    assert call_watches.list_watches(TEST_OID) == []
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (declared before the `{join_url_hash}` routes; mark both with a `# LEGACY (spec E6): remove once fleet > v2.0.2x` comment): union route sorts the concatenated lists by `seq`; delete-all loops `list_watches` → per-meeting delete + best-effort subscription delete + one audit event per watch.
- [ ] **Step 4: Run**: `python -m pytest tests/test_call_watch_routes.py -q` — PASS.
- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat: legacy current/* call-watch aliases for v2.0.25 fleet (spec E6)"`

### Task 4: Contract doc

**Files:**
- Modify: `docs/rest-contract-v1.md` (§9 call watches)

- [ ] **Step 1:** Document the per-meeting routes (`POST /call-watches` per-meeting replace + `409 watch_limit`; `GET/DELETE /call-watches/{join_url_hash}`; hash = sha256 hex of `joinWebUrl`), and move `current/*` to a "deprecated aliases" subsection with removal criteria (fleet past v2.0.2x).
- [ ] **Step 2:** `python -m pytest -q` (docs-only change; suite green = nothing broke).
- [ ] **Step 3: Commit**: `git add -A && git commit -m "docs: per-meeting call-watch contract (spec E2/E3/E6)"`

**End of Phase 1.** Do NOT merge/deploy yet — deploy happens with Task 10's checklist (API first, desktop after; legacy aliases make API-first safe for the fleet).

---

## Phase 2 — local backend (`C:\Projects\meeting-notetaker-2\backend`)

### Task 5: Storage client + stub per-meeting methods

**Files:**
- Modify: `backend/app/services/storage_api.py` (protocol ~lines 217–221, stub ~540–560, REST client ~878–915)
- Test: `backend/tests/test_storage_api_call_watch.py` (extend)

The local backend ships inside the desktop release, so its desktop-facing
shape can change freely (no fleet skew at this layer). `register_call_watch`
is unchanged; signals/delete become per-meeting.

- [ ] **Step 1: Failing tests** (existing opener-fake style): REST client
  `get_call_signals("a"*64, token)` issues
  `GET /api/v1/call-watches/aaaa…/signals`; `delete_call_watch("a"*64, token)`
  issues `DELETE /api/v1/call-watches/aaaa…` with `allow_not_found`; stub
  no-ops accept the new argument.
- [ ] **Step 2:** `python -m pytest backend/tests/test_storage_api_call_watch.py -q` — FAIL (signature).
- [ ] **Step 3: Implement**: change the protocol, stub, and REST client method
  signatures to `get_call_signals(self, join_url_hash: str, access_token)` /
  `delete_call_watch(self, join_url_hash: str, access_token)` targeting the
  per-meeting paths.
- [ ] **Step 4:** Suite: `python -m pytest backend/tests -q` — PASS.
- [ ] **Step 5: Commit** (desktop repo): `git checkout -b feature/call-watch-per-meeting && git add -A && git commit -m "feat(backend): per-meeting storage-api call-watch client"`

### Task 6: Relay routes + desktop request policy

**Files:**
- Modify: `backend/app/routers/call_watch.py`
- Modify: `src/main/api-request-policy.ts:49-51`
- Test: `backend/tests/test_call_watch_routes.py` (extend), `src/main/api-request-policy` verify (`npm run typecheck` + existing policy tests if present)

- [ ] **Step 1: Failing tests**: relay `GET /api/v1/call-watch/{h}/signals` and
  `DELETE /api/v1/call-watch/{h}` forward the hash to the client (assert via
  recording fake client); malformed hash → 422 (FastAPI `Path` regex
  `^[0-9a-f]{64}$`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement**: add `join_url_hash: Annotated[str, Path(pattern=r"^[0-9a-f]{64}$")]` params to the GET/DELETE handlers (keep POST as-is; delete the old parameterless GET/DELETE — nothing else calls them). In `api-request-policy.ts` replace the two exact matches with:

```ts
    (req.method === 'GET' && /^\/api\/v1\/call-watch\/[0-9a-f]{64}\/signals$/.test(path)) ||
    (req.method === 'DELETE' && /^\/api\/v1\/call-watch\/[0-9a-f]{64}$/.test(path))
```

- [ ] **Step 4:** `python -m pytest backend/tests -q` and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat(backend): per-meeting call-watch relay routes"`

---

## Phase 3 — desktop main (`C:\Projects\meeting-notetaker-2`)

### Task 7: Poller core — attach mode + baseline drain

**Files:**
- Modify: `src/main/call-signals-core.ts`
- Modify: `scripts/verify-call-signals.ts` (extend harness)

Spec E5. The machine gains `primeSeen(signals)` (adds seqs to the seen-set,
fires nothing, no-op when `done`). The poller gains
`mode: 'register' | 'attach'` and a per-meeting `joinUrlHash`:

- URLs: `watchUrl = ${apiBase}/api/v1/call-watch` (POST only);
  `meetingUrl = ${apiBase}/api/v1/call-watch/${joinUrlHash}`;
  `signalsUrl = ${meetingUrl}/signals`; DELETE targets `meetingUrl`.
- `mode: 'attach'`: `start()` skips registration entirely → status
  `'polling'` → issues an **immediate** first poll whose successful response
  is fed to `machine.primeSeen(...)` instead of `ingest` (`baselined` flag);
  every later poll ingests as today. A failed first poll does NOT count as
  baselined — retry priming on the next tick (signals present before the
  first *successful* poll predate recording by construction).
- `mode: 'register'` (fallback, today's behaviour): registration → polling;
  no baseline (a fresh subscription generation has no prior signals).
- `stop()` unchanged except it DELETEs `meetingUrl`; in attach mode
  `mayHaveWatch` is always true.
- Known accepted race (document in the module header): a genuine
  `recorder_left` landing between attach and the first successful poll is
  drained; grace/scheduled auto-stop still bound the damage.

- [ ] **Step 1:** Extend `scripts/verify-call-signals.ts` with failing cases: `primeSeen` marks without acting (subsequent ingest of same seqs is a no-op; new seqs still transition); attach-mode start skips POST and polls immediately; first-poll signals are primed not ingested; second-poll new signal pauses; attach-mode stop DELETEs the per-meeting URL; register-mode unchanged (existing cases keep passing with the new `joinUrlHash` dep threaded in).
- [ ] **Step 2:** `npm run verify:call-signals` — FAIL (new deps/methods missing).
- [ ] **Step 3:** Implement in `call-signals-core.ts` (machine: `primeSeen`; poller: `mode`, `joinUrlHash`, `baselined` logic, URL changes).
- [ ] **Step 4:** `npm run verify:call-signals` && `npm run typecheck` — PASS.
- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat: attach-mode poller with baseline drain (spec E5)"`

### Task 8: Runtime layer — transport helpers + attach wiring

**Files:**
- Modify: `src/main/call-signals.ts`
- Test: `npm run verify:call-signals` (core untouched — this is thin runtime glue), `npm run typecheck`

- [ ] **Step 1:** Add to `call-signals.ts`:
  - `export function joinUrlHash(joinWebUrl: string): string` — `createHash('sha256').update(joinWebUrl).digest('hex')` (must equal Python `hashlib.sha256(url.encode()).hexdigest()`; both UTF-8).
  - `export interface CallWatchTransport { apiBase, http, identityHeaders }` and `export function createCallWatchTransport(deps = runtimeDeps): CallWatchTransport | null` — reuses `defaultHttp` + `createIdentityHeaderProvider` + the same `MN_API_BASE` resolution, so the registrar (Task 9) shares one transport path with the poller.
  - `armCallSignals(recording, deps, hasActiveWatch?: (hash: string) => boolean)`: compute `hash = joinUrlHash(decision.joinWebUrl)`; pass `joinUrlHash: hash` and `mode: hasActiveWatch?.(hash) ? 'attach' : 'register'` into `createCallSignalPoller`. Log the mode in the arming line: `{ eventId, mode, graceMs, pollIntervalMs }`.
- [ ] **Step 2:** `npm run typecheck && npm run verify:call-signals` — PASS.
- [ ] **Step 3: Commit**: `git add -A && git commit -m "feat: call-signal attach wiring + shared call-watch transport"`

### Task 9: Watch registrar (core + runtime)

**Files:**
- Create: `src/main/call-watch-registrar-core.ts` (pure, Electron-free — same discipline as `call-signals-core.ts`)
- Create: `src/main/call-watch-registrar.ts` (runtime: persisted JSON state + transport)
- Create: `scripts/verify-call-watch-registrar.ts`
- Modify: `package.json` (script `"verify:call-watch-registrar": "..."` mirroring `verify:call-signals`'s esbuild invocation)

**Core** (`call-watch-registrar-core.ts`):

```ts
export interface RegistrarWatch {
  joinWebUrl: string
  joinUrlHash: string
  startUtc: string
  scheduledEndUtc: string
  subscriptionExpiresUtc?: string
}

export interface RegistrarState { watches: Record<string, RegistrarWatch> } // key = idempotencyKey

export interface RegistrarActions {
  register: Array<{ key: string; watch: RegistrarWatch }>
  remove: Array<{ key: string; joinUrlHash: string }>
}

export const REGISTRAR_CAP = 5 // spec E3, mirrors the server cap
```

`planRegistrarActions(state, decisions, now): RegistrarActions` — pure rules:

1. **Candidate set** from `decisions` (type `GraphEventDecision[]`, type-only import): `status === 'candidate'`, `reason` is `'eligible' | 'not_due_yet'`, `metadata.joinWebUrl` present, `logContext.endUtc` in the future, and `evaluateHostGate(decision, signedInEmail).allowed` (NOT `.hostGateAllowed` — that name only exists on `hostGateLogContext`'s output; host gate is pure — import from `./graph/host-gate`).
2. **Remove**: any tracked watch whose meeting is now cancelled/ended (key seen in `decisions` with an excluded reason, or `scheduledEndUtc` past `now`) → remove. A tracked meeting simply *absent* from this sync's decisions is NOT removed (delta syncs only carry changes).
3. **Re-register** (spec E4): key present in both, but `startUtc`/`scheduledEndUtc`/`joinWebUrl` changed → remove + register.
4. **Register**: candidates not yet tracked, sorted by `startUtc` ascending, admitted until `tracked + admitted == REGISTRAR_CAP`; the rest wait for a future sync.

**Runtime** (`call-watch-registrar.ts`): holds `RegistrarState` persisted at a
caller-supplied `statePath` (JSON read/write with the same tolerant-parse
pattern as `graph/store.ts`); `handleSyncDecisions(decisions)` runs the
planner then executes: removes → `DELETE {apiBase}/api/v1/call-watch/{hash}`
(30s mutation budget, failure = log `[call-watch-registrar] delete failed
{ status }` and drop from state anyway — orphans self-expire per D3);
registers → `POST {apiBase}/api/v1/call-watch` with
`{join_web_url, scheduled_end_utc}` — on 2xx store
`subscription_expires_utc`; on 409 log `{ status: 409 }` and DON'T store
(cap reached — retried naturally next sync); other failures log status-only
and retry next sync. Exposes `hasActiveWatch(hash): boolean` and
`noteWatchDeleted(hash)` (drops the entry; called on recording disarm).
Serialize `handleSyncDecisions` (an in-flight run makes the next call a
no-op) so a slow HTTP call can never interleave with the next sync.
Gate everything on the same checks as `shouldArmCallSignals` minus the
recording-specific ones: `MN_CALL_SIGNALS_ENABLED !== 'false'`,
`isStorageApiEnabled(env)`, `MN_STORAGE_API_SCOPE` non-empty.
**Privacy:** log context carries `eventId`/hash prefixes and statuses only —
never join URLs (parent-spec rule).

- [ ] **Step 1:** Write `scripts/verify-call-watch-registrar.ts` (failing) covering: soonest-first cap admission (7 candidates → 5 registered, the 5 soonest); cancelled meeting → remove; reschedule → remove+register; absent-from-delta ≠ removed; 409 keeps candidate untracked and retried on next plan; `hasActiveWatch` truth; state round-trips through JSON.
- [ ] **Step 2:** `npm run verify:call-watch-registrar` — FAIL.
- [ ] **Step 3:** Implement core + runtime.
- [ ] **Step 4:** `npm run verify:call-watch-registrar && npm run typecheck` — PASS.
- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat: call-watch registrar — register at discovery, cap 5 soonest-first (spec E1/E3/E4)"`

### Task 10: Wiring, docs, end-to-end verify

**Files:**
- Modify: `src/main/graph/runtime.ts` (new optional `onSyncCompleted` callback)
- Modify: `src/main/index.ts` (instantiate registrar; wire callbacks)
- Modify: `src/main/recording-ipc.ts:224` and the disarm path (~line 534)
- Modify: `docs/storage-api/rest-contract-v1.md` (the desktop-repo mirror of Task 4), spec cross-reference in `docs/superpowers/specs/2026-08-14-call-watch-per-meeting-design.md` (status → Implemented)

- [ ] **Step 1:** `runtime.ts`: add `onSyncCompleted?: (decisions: GraphEventDecision[]) => void` to `GraphRuntimeOptions`; invoke after the success log in `syncGraphDetectionOnce` with `detection.decisions` (all of them — the registrar filters).
- [ ] **Step 2:** `index.ts`: create the registrar once at startup —
  `statePath: join(app.getPath('userData'), 'call-watch-registrar.json')`,
  transport from `createCallWatchTransport()` — and pass
  `onSyncCompleted: (d) => void registrar.handleSyncDecisions(d)` into
  `startGraphDetectionRuntime` (line ~320, next to `onAutoRecordEligible`).
- [ ] **Step 3:** `recording-ipc.ts`: arm becomes
  `armCallSignals(recording, undefined, (h) => registrar.hasActiveWatch(h))`
  (import the registrar accessor via the same wiring `configureCallSignals`
  uses). For disarm: the shared helper `closePausedToastAndDisarm()`
  (~line 534) currently takes NO arguments and does not know the recording —
  either thread the active recording's `joinWebUrl` into it as an optional
  parameter, or place the `registrar.noteWatchDeleted(joinUrlHash(url))`
  call at each of its call sites where the recording (and its
  `metadata.joinWebUrl`) is in scope. Pick whichever keeps the helper's
  toast-before-disarm ordering contract intact — the registrar must not
  think it still holds a slot after the poller's DELETE removed the watch.
- [ ] **Step 4:** Full verify: `npm run typecheck && npm run verify:call-signals && npm run verify:call-watch-registrar && npm run verify:toast-xml` and backend `python -m pytest backend/tests -q` — all PASS.
- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat: wire watch registrar into calendar sync + recording lifecycle"`

**Deploy/rollout checklist (human-gated, after both branches reviewed):**
1. Merge + deploy storage-api first (legacy aliases keep the v2.0.25 fleet working).
2. Live smoke against prod with two scheduled test meetings (the acceptance scenarios in the spec — especially: watch registered at discovery minutes ahead; join late; leave → pause + toast; camera-check pre-join → no false pause).
3. Merge desktop, cut release, feed-verify, fleet rolls.
4. Remove the legacy aliases in a later storage-api change once the fleet is past the new version.

**Rollback warning:** rolling the desktop back from the per-meeting release to
v2.0.25 can leave several parked watches behind. The legacy client reads their
signals as one union, so a terminal signal from a different parked meeting can
stop the next recording incorrectly. Before a rollback, clear
`callwatches/{oid}/` for affected users. Without that cleanup, accept one
at-risk recording; the first legacy DELETE removes all parked watches, so the
risk is self-limiting.
