# Meeting Call Events Auto-Pause/Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause the recording (with a 60s grace window + Upload/Resume toast) when the recording user leaves their Teams meeting, and stop it outright on `callEnded` or grace expiry — driven by Graph meetingCallEvents change notifications.

**Architecture:** The storage-api owns the Graph subscription lifecycle, the encrypted webhook, and a per-user signal store in blob storage; the local FastAPI backend relays three routes; Electron main polls signals every 10s and drives the *existing* pause/resume/stop surfaces. Spec: `docs/superpowers/specs/2026-08-12-meeting-call-events-design.md` (read it first — decisions D1–D9 govern every task). The proven Graph mechanics live in `spikes/meeting-call-events/` (`subscribe.py` = subscription request shape, `webhook.py` = decryption, `selftest.py` = encrypt-like-Graph fixture logic).

**Tech Stack:** Python 3.11 + FastAPI + PyJWT + `cryptography` (storage-api, pytest); Python FastAPI (local backend, pytest); Electron main TypeScript (desktop, esbuild `verify:*` harnesses — this repo has no vitest).

**Repos:** Tasks 1–8 in `C:\Projects\notetaker-storage-api` (own git). Tasks 9–14 in `C:\Projects\meeting-notetaker-2`. Commit in the repo you edited.

---

## Phase 1 — storage-api (`C:\Projects\notetaker-storage-api`)

### Task 1: Settings + `cryptography` dependency

**Files:**
- Modify: `app/config.py`
- Modify: `requirements.txt`
- Test: `tests/test_call_watch_config.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_call_watch_config.py
from app.config import Settings


def test_call_watch_settings_default_off_and_empty():
    s = Settings()
    assert s.call_watches_enabled is False
    assert s.graph_client_id == ""
    assert s.graph_client_secret == ""
    assert s.graph_enc_cert_pem == ""
    assert s.graph_enc_key_pem == ""
    assert s.graph_client_state == ""
    assert s.graph_cert_id == "notetaker-callwatch-cert"
```

- [ ] **Step 2: Run it to make sure it fails**

Run (repo root): `python -m pytest tests/test_call_watch_config.py -q`
Expected: FAIL (`AttributeError: call_watches_enabled`)

- [ ] **Step 3: Implement**

In `app/config.py`, add to `Settings` (after `appinsights_connection_string`):

```python
    # Meeting call events (spec 2026-08-12, D3/D8). Feature ships dark until
    # the Graph app registration + cert exist; empty settings keep it off.
    call_watches_enabled: bool = False
    graph_client_id: str = ""
    graph_client_secret: str = ""
    graph_enc_cert_pem: str = ""   # public cert, PEM (also sent b64-DER to Graph)
    graph_enc_key_pem: str = ""    # private key, PEM
    graph_client_state: str = ""
    graph_cert_id: str = "notetaker-callwatch-cert"
```

Append `cryptography` on its own line in `requirements.txt`, then `pip install cryptography` into the venv used for tests.

- [ ] **Step 4: Run the full suite** — `python -m pytest -q` — Expected: PASS (new + existing).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: call-watch settings + cryptography dep (spec 2026-08-12 D8)"`

### Task 2: Graph-payload crypto + test fixture generator

Port the spike's proven code. **Source of truth:** `meeting-notetaker-2/spikes/meeting-call-events/webhook.py` (`decrypt_payload`) and `selftest.py` (`encrypt_like_graph`).

**Files:**
- Create: `app/services/call_crypto.py`
- Create: `tests/graph_fixtures.py` (test-only encrypt twin)
- Test: `tests/test_call_crypto.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_call_crypto.py
import pytest

from app.services.call_crypto import DecryptError, decrypt_payload
from tests.graph_fixtures import TEST_CERT_PEM, TEST_KEY_PEM, encrypt_like_graph

PAYLOAD = {"eventType": "rosterUpdated", "participants@delta": []}


def test_roundtrip_decrypts_to_original():
    enc = encrypt_like_graph(PAYLOAD)
    assert decrypt_payload(enc, TEST_KEY_PEM) == PAYLOAD


def test_tampered_data_raises():
    enc = encrypt_like_graph(PAYLOAD)
    enc["dataSignature"] = enc["dataSignature"][:-4] + "AAA="
    with pytest.raises(DecryptError):
        decrypt_payload(enc, TEST_KEY_PEM)
```

`tests/graph_fixtures.py`: port `encrypt_like_graph` verbatim from the spike's `selftest.py` (AES-256-CBC + PKCS7, HMAC-SHA256 over ciphertext, RSA-OAEP-SHA1 key wrap), plus a `TEST_CERT_PEM`/`TEST_KEY_PEM` pair generated **once** with `cryptography` at import time (2048-bit, self-signed) so tests need no files on disk.

- [ ] **Step 2: Run to verify failure** — `python -m pytest tests/test_call_crypto.py -q` → FAIL (module missing).

- [ ] **Step 3: Implement `app/services/call_crypto.py`**

Port `decrypt_payload` from the spike's `webhook.py`, adapted: takes `(encrypted_content: dict, private_key_pem: str)`, raises `DecryptError` (new exception) on HMAC mismatch or malformed input; use `hmac.compare_digest`. Keep the exact algorithm chain: RSA-OAEP-**SHA1** unwrap → HMAC-SHA256 verify over the still-encrypted bytes → AES-256-CBC, IV = first 16 bytes of symmetric key, strip PKCS7.

- [ ] **Step 4: Run** — `python -m pytest tests/test_call_crypto.py -q` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: graph rich-notification decrypt (ported from 12 Aug spike)"`

### Task 3: Signal reduction (case-insensitive parse)

**Files:**
- Create: `app/services/call_signals.py`
- Test: `tests/test_call_signals.py`

- [ ] **Step 1: Failing tests** — cover D1 + spike finding 8:

```python
# tests/test_call_signals.py
from app.services.call_signals import reduce_to_signals

OID = "965316fc-61b5-4006-9e2b-f492557f16be"


def _delta(uid, removed_reason=None, in_lobby=False, pascal=True):
    user = {"Id": uid, "DisplayName": "X", "TenantId": "t"} if pascal else {"id": uid}
    d = {"Info": {"Identity": {"User": user}}, "IsInLobby": in_lobby, "Id": "p1"}
    if removed_reason:
        d["RemovedState"] = {"Reason": removed_reason}
    if not pascal:  # camelCase twin, keys lowercased first letter
        d = {"info": {"identity": {"user": user}}, "isInLobby": in_lobby,
             **({"removedState": {"reason": removed_reason}} if removed_reason else {}), "id": "p1"}
    return d


def test_call_ended_reduces():
    out = reduce_to_signals({"eventType": "callEnded", "eventDateTime": "2026-08-12T02:34:28Z"}, OID)
    assert [s["type"] for s in out] == ["call_ended"]


def test_recorder_leave_and_rejoin_pascal_and_camel():
    for pascal in (True, False):
        left = {"eventType": "rosterUpdated", "eventDateTime": "2026-08-12T02:05:04Z",
                "participants@delta": [_delta(OID, "Participant has left the meeting call.", pascal=pascal)]}
        joined = {"eventType": "rosterUpdated", "eventDateTime": "2026-08-12T02:05:30Z",
                  "participants@delta": [_delta(OID, pascal=pascal)]}
        assert [s["type"] for s in reduce_to_signals(left, OID)] == ["recorder_left"]
        assert [s["type"] for s in reduce_to_signals(joined, OID)] == ["recorder_rejoined"]


def test_inactive_state_is_recorder_left():  # spec D9
    ev = {"eventType": "rosterUpdated", "eventDateTime": "2026-08-12T02:05:04Z",
          "participants@delta": [_delta(OID, "Participant has entered an inactive state in the roster.")]}
    assert [s["type"] for s in reduce_to_signals(ev, OID)] == ["recorder_left"]


def test_other_participants_lobby_and_callstarted_discarded():
    ev = {"eventType": "rosterUpdated", "eventDateTime": "2026-08-12T02:00:00Z",
          "participants@delta": [_delta("someone-else", "Participant has left the meeting call."),
                                 _delta(OID, in_lobby=True)]}
    assert reduce_to_signals(ev, OID) == []          # others + lobby joins: not signals
    assert reduce_to_signals({"eventType": "callStarted", "eventDateTime": "x"}, OID) == []
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `reduce_to_signals(payload: dict, watch_oid: str) -> list[dict]` with a recursive case-insensitive getter (`_ci(d, key)`), returning `{"type", "event_utc"}` dicts. Rules: `callEnded` → `call_ended`; `rosterUpdated` deltas where the user id == `watch_oid` (case-insensitive compare) → `recorder_left` if any `removedState` present, else `recorder_rejoined` when `isInLobby` is falsy; everything else discarded. Lobby joins are not rejoins.
- [ ] **Step 4: Run → PASS.** Full suite too.
- [ ] **Step 5: Commit** — `git commit -am "feat: reduce graph call events to per-user signals (spec D1/D9)"`

### Task 4: Graph subscription client

**Files:**
- Create: `app/services/graph_subscriptions.py`
- Test: `tests/test_graph_subscriptions.py`

- [ ] **Step 1: Failing tests** — monkeypatch the module's `_http` seam; no network.

```python
# tests/test_graph_subscriptions.py
import json

from app.services import graph_subscriptions as gs


def test_create_uses_beta_joinweburl_resource_and_clamped_expiry(monkeypatch, call_watch_settings):
    calls = []

    def fake_http(method, url, body, headers, timeout):
        calls.append((method, url, body))
        if url.endswith("/token"):
            return {"access_token": "tok", "expires_in": 3600}
        return {"id": "sub-1", "expirationDateTime": "2026-08-12T23:00:00Z"}

    monkeypatch.setattr(gs, "_http", fake_http)
    sub = gs.create_subscription("https://teams.microsoft.com/l/meetup-join/x?a=%22b%22",
                                 scheduled_end_utc="2026-08-12T11:00:00Z",
                                 notification_url="https://f/graph/call-notifications")
    assert sub["id"] == "sub-1"
    method, url, body = calls[-1]
    assert url == "https://graph.microsoft.com/beta/subscriptions"
    assert "communications/onlineMeetings(joinWebUrl='" in body["resource"]
    assert "%2522b%2522" in body["resource"]          # double URL-encoding, like the spike
    assert body["changeType"] == "updated"
    assert body["includeResourceData"] is True
    assert body["clientState"] == call_watch_settings.graph_client_state
    # expiry = scheduled end + 12h
    assert body["expirationDateTime"].startswith("2026-08-12T23:00:00")


def test_delete_hits_v1(monkeypatch, call_watch_settings):
    urls = []
    monkeypatch.setattr(gs, "_http", lambda m, u, b, h, t: urls.append((m, u)) or {})
    gs.delete_subscription("sub-9")
    assert ("DELETE", "https://graph.microsoft.com/v1.0/subscriptions/sub-9") in urls
```

Add a `call_watch_settings` fixture in `tests/conftest.py` that monkeypatches `get_settings` cache with populated graph settings (follow the existing settings-injection pattern used by other tests in this repo — read `tests/conftest.py` first and copy its idiom).

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — stdlib `urllib.request` (same taste as the local backend's `RestStorageApiClient`): module-level `_http(method, url, body, headers, timeout)` seam; `_app_token()` (client credentials, cached until expiry−60s); `create_subscription(join_web_url, scheduled_end_utc, notification_url)` — resource `communications/onlineMeetings(joinWebUrl='{urllib.parse.quote(join_web_url, safe="")}')/meetingCallEvents` **on /beta** (transcribe the body from the spike's `subscribe.py:create`), `encryptionCertificate` = base64 DER derived from `graph_enc_cert_pem` via `cryptography.x509`, expiry = `scheduled_end + 12h` clamped to `now + 70h`; `delete_subscription(sub_id)` on v1.0, swallow 404. Raise `GraphError` on non-2xx (router maps to 502 `graph_error`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: graph meetingCallEvents subscription client (beta create, v1 delete)"`

### Task 5: Watch store + blob prefix helpers

**Files:**
- Modify: `app/services/blob.py` (add `list_json_prefix`, `delete_prefix`)
- Create: `app/services/call_watches.py`
- Test: `tests/test_call_watch_store.py`

- [ ] **Step 1: Failing tests** — use the repo's existing blob-stubbing idiom (read how `tests/` fake the blob service — e.g. the meetings tests — and mirror it):
  - `replace_watch(oid, ...)` writes `callwatches/{oid}/watch.json`, returns prior watch (for subscription cleanup), and deletes the prior signal prefix.
  - `append_signal(oid, signal)` writes `callwatches/{oid}/signals/{seq}.json` via `put_json_if_absent` (write-once; duplicate seq → dropped, not an error).
  - `list_signals(oid)` returns all signals sorted by `seq`.
  - `delete_watch(oid)` removes watch + signals, returns the watch (or None).
  - `find_watch_by_subscription(subscription_id)` / or by `client_state` lookup used by the webhook to route notifications → decide: store `subscription_id` in watch.json and look up by scanning `callwatches/*/watch.json` (`list_json_prefix("callwatches/")` filtered to `/watch.json`). Fleet size makes the scan cheap.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `seq = f"{received:%Y%m%dT%H%M%S%f}-{suffix}"` where `suffix` is the notification's `id`[:8] if present, else `uuid4().hex[:8]` (Graph marks the item `id` optional). Blob helpers follow `blob.py`'s existing error mapping (`StorageUnavailable`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: call-watch blob store (one watch per oid, write-once signals)"`

### Task 6: Authenticated watch routes

**Files:**
- Create: `app/routers/call_watches.py`
- Modify: `app/main.py` (add router to `PRODUCTION_ROUTERS`)
- Modify: `app/models.py` (request/response models)
- Test: `tests/test_call_watch_routes.py`

- [ ] **Step 1: Failing tests** (use `make_app_client` + `make_token(scopes="access_as_user")`):
  - `POST /api/v1/call-watches` with `{join_web_url, scheduled_end_utc}` → 200 `{watch_id, subscription_expires_utc}`; asserts `create_subscription` called and watch stored under the **token's** oid (body oid ignored/absent).
  - Re-POST → prior subscription deleted (replace semantics).
  - `GET /api/v1/call-watches/current/signals` → `{"signals": [...]}` all signals, sorted.
  - `DELETE /api/v1/call-watches/current` → 204, subscription delete attempted.
  - Flag off (`call_watches_enabled=False`) → 503 `feature_disabled` on all three.
  - No `access_as_user` scope → 403 (require_scoped_user), missing token → 401.
  - Graph failure on create → 502 `graph_error`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — plain `def` handlers (sync, like `meetings.py`), `Depends(require_scoped_user)`, `audit.record_event` on create/delete (follow `meetings.py`'s audit call shape). Add router to `PRODUCTION_ROUTERS` in `app/main.py` — through the existing guarded include only.
- [ ] **Step 4: Run full suite → PASS** (the auth-invariant test must still pass untouched — these routes are guarded).
- [ ] **Step 5: Commit** — `git commit -am "feat: call-watch routes (create/replace, signals, delete)"`

### Task 7: Graph webhook route (the single auth exception)

**Files:**
- Create: `app/routers/graph_webhook.py`
- Create: `app/services/graph_webhook_auth.py` (validationTokens JWT check)
- Modify: `app/main.py` (mount exception + inline comment naming spec D4)
- Modify: `tests/test_auth_dependencies.py` (sanction exactly this path)
- Test: `tests/test_graph_webhook.py`

- [ ] **Step 1: Failing tests**
  - Handshake: `POST /graph/call-notifications?validationToken=abc` → 200, body `abc`, content-type starts `text/plain`.
  - Valid encrypted notification (built with `tests/graph_fixtures.encrypt_like_graph`, `clientState` matching settings, `validationTokens` validation monkeypatched to pass) → 202 and a signal blob written for the watch's oid.
  - Wrong `clientState` → 202 but **no** signal written.
  - `call_watches_enabled=False` → still 202 (D8: the webhook must keep
    acking while the feature is dark so Graph doesn't disable the
    subscription; never guard this route with the feature flag).
  - JWT validation failure → 202, no signal (drop + log; never 4xx/5xx to Graph).
  - Decrypt failure → 202, no signal.
  - Unknown subscription id → 202, no signal.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
  - `graph_webhook_auth.validate_notification_jwt(token)` — PyJWT, keys via the existing `app.auth.tokens._jwks_client_for(settings.tenant_id)`, audience `settings.graph_client_id`, issuer accepted in **both** forms (`https://sts.windows.net/{tid}/` v1 and `https://login.microsoftonline.com/{tid}/v2.0`), and `azp`/`appid` claim must equal `0bf30f3b-4a52-48df-9a82-234910c4a086` (Microsoft Graph Change Tracking). Raises `TokenError` on any failure.
  - Router: async handler; echo handshake first; else parse body, and for each `value` item: clientState check → JWT check (any one valid token from `validationTokens` covers the batch, per docs validate all) → decrypt → `reduce_to_signals(payload, watch.oid)` where the watch is found via `find_watch_by_subscription(item.subscriptionId)` → `append_signal`. Always `Response(status_code=202)`; every drop reason logged with correlation id, **no join URLs/titles/emails in logs**.
  - `app/main.py`: `app.include_router(graph_webhook.router)` next to health, with the D4 comment. Update the invariant test: allow-list `{"/graph/call-notifications"}` alongside `/health` and assert the allow-list is exactly that.
- [ ] **Step 4: Run full suite → PASS** (including the modified invariant test).
- [ ] **Step 5: Commit** — `git commit -am "feat: graph call-notifications webhook (spec D4 auth exception)"`

### Task 8: storage-api docs + contract

**Files:**
- Modify: `docs/rest-contract-v1.md` (new §: call watches — three routes + webhook, feature flag, error codes)
- Modify: `docs/runbook.md` (new app settings incl. cert generation one-liners, kill switch, "signals not flowing" triage: subscription exists? webhook 202s in App Insights? flag on?)

- [ ] **Step 1: Write both doc sections.** Include the ops table: `NSA_CALL_WATCHES_ENABLED`, `NSA_GRAPH_CLIENT_ID`, `NSA_GRAPH_CLIENT_SECRET`, `NSA_GRAPH_ENC_CERT_PEM`, `NSA_GRAPH_ENC_KEY_PEM`, `NSA_GRAPH_CLIENT_STATE` (generate: `python -c "import secrets;print(secrets.token_urlsafe(24))"`), `NSA_GRAPH_CERT_ID`.
- [ ] **Step 2: Commit** — `git commit -am "docs: call-watch contract + runbook entries"`

## Phase 2 — local backend relay (`C:\Projects\meeting-notetaker-2`)

### Task 9: Storage client methods (Rest + Stub)

**Files:**
- Modify: `backend/app/services/storage_api.py` (Protocol + both impls)
- Modify: `backend/app/schemas.py` (DTOs: `CallWatchRegistration{join_web_url, scheduled_end_utc}`, `CallSignal{seq,type,event_utc,received_utc}`, `CallSignalsResponse{signals}`)
- Test: `backend/tests/test_storage_api_call_watch.py`

- [ ] **Step 1: Failing tests** — follow this repo's existing `RestStorageApiClient` test idiom (read how `backend/tests` stub `_request`): `register_call_watch` → `POST /api/v1/call-watches` with bearer; `get_call_signals` → `GET /api/v1/call-watches/current/signals`; `delete_call_watch` → `DELETE /api/v1/call-watches/current`, 404 tolerated. Stub client: register→ok, signals→empty list, delete→ok, all no-network.
- [ ] **Step 2: Run → FAIL** (`cd backend && python -m pytest tests/test_storage_api_call_watch.py -q`).
- [ ] **Step 3: Implement** — three methods on the `StorageApiClient` Protocol, `RestStorageApiClient` (via the existing `_request` + error taxonomy) and `StubStorageApiClient`.
- [ ] **Step 4: Run backend suite → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(backend): storage client call-watch methods + stub no-ops"`

### Task 10: Relay routes

**Files:**
- Create: `backend/app/routers/call_watch.py`
- Modify: `backend/app/main.py` (include router — match how `people.py`/`voiceprint_admin.py` are registered)
- Test: `backend/tests/test_call_watch_routes.py`

- [ ] **Step 1: Failing tests** — `POST /api/v1/call-watch`, `GET /api/v1/call-watch/signals`, `DELETE /api/v1/call-watch`: forward `X-MN-Storage-Token` to the client (assert token threaded), map `StorageApiUnavailable` → 503 / `StorageApiRejected` → 502 (copy the mapping used in `voiceprint_admin.py`), stub mode returns the no-op shapes.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — thin: header extraction (`StorageToken` alias pattern from `people.py:30`), call `get_storage_api_client()`, return DTOs.
- [ ] **Step 4: Run backend suite → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(backend): call-watch relay routes"`

## Phase 3 — desktop (`C:\Projects\meeting-notetaker-2`)

### Task 11: Toast verbs + paused toast XML

**Files:**
- Modify: `src/main/toast-xml.ts` (`ToastAction` union += `'upload-now' | 'resume-recording'`; `toastActionFromArgv` handles both `notetaker://` URIs; new `buildRecordingPausedToastXml(body: string)` — `scenario="reminder"`, silent audio, buttons **Upload now** → `toastUri('upload-now')`, **Keep recording** → `toastUri('resume-recording')`, matching `buildEndingSoonToastXml`'s structure)
- Modify: `scripts/verify-toast-xml.ts` (assert new verbs parse, new XML contains both action URIs + `scenario="reminder"`)

- [ ] **Step 1: Extend the verify script first** (it is the failing test): add assertions, run `npm run verify:toast-xml` → FAIL.
- [ ] **Step 2: Implement in `toast-xml.ts`.**
- [ ] **Step 3: Run `npm run verify:toast-xml`** → PASS. Also `npm run typecheck` if the repo defines it (check `package.json`).
- [ ] **Step 4: Commit** — `git commit -am "feat: paused-recording toast + upload/resume protocol verbs"`

### Task 12: Call-signal state machine + poller (pure core, injected I/O)

**Files:**
- Create: `src/main/call-signals.ts`
- Create: `scripts/verify-call-signals.ts`
- Modify: `package.json` (script `"verify:call-signals": "esbuild scripts/verify-call-signals.ts --bundle --platform=node --format=cjs --outfile=out/verify-call-signals.cjs --log-level=error --external:electron && node out/verify-call-signals.cjs"`)

Design the module in two layers so the harness needs no Electron:

```ts
// Pure core — everything injectable.
export interface CallSignal { seq: string; type: 'recorder_left' | 'recorder_rejoined' | 'call_ended'; event_utc: string; received_utc: string }
export interface CallSignalActions {
  pause(): void            // -> sendTrayRecordingControl('pause')
  resume(): void           // -> sendTrayRecordingControl('resume')
  stop(): void             // -> sendAutoStopRequest()
  showPausedToast(): void  // sticky toast AND the renderer chime — send the
                           // 'notification:chime' IPC exactly like
                           // notifyMeetingEndingSoon does (toasts are silent
                           // by repo convention; the renderer owns the wav)
  closePausedToast(): void
  isPaused(): boolean      // -> isRecordingPaused()
}
export function createCallSignalMachine(actions: CallSignalActions, graceMs = 60_000, timers = { setTimeout, clearTimeout }) {
  // seen: Set<string> of seq; state: 'watching' | 'grace' | 'done'
  // signalInitiatedPause: boolean
  return {
    ingest(signals: CallSignal[]): void,   // dedupe by seq, then per spec:
    // recorder_left in 'watching': pause (only if !isPaused(); record signalInitiatedPause), grace timer, toast
    // recorder_rejoined in 'grace': cancel timer; resume only if signalInitiatedPause; close toast; back to 'watching'
    // call_ended any state != done: cancel timer, stop(), 'done'
    // grace expiry: stop(), 'done'
    onManualResume(): void,   // user resumed from tray/screen during grace: cancel grace, keep watching
    onToastAction(a: 'upload-now' | 'resume-recording'): void, // stop() / resume+cancel
    dispose(): void
  }
}
```

The poller half (same file): `armCallSignals(recording: ActiveRecording)` — no-op unless `MN_CALL_SIGNALS_ENABLED !== 'false'`, `recording.source === 'auto'`, `metadata.joinWebUrl` present, and `isStorageApiEnabled(process.env)`. It POSTs the watch through the local backend (one retry after 30s), then polls GET signals every 10s, feeding `machine.ingest`. Reuse the api-proxy fetch shape: `fetch(`${process.env.MN_API_BASE ?? 'http://127.0.0.1:8787'}/api/v1/call-watch...`)` with headers from `storageIdentityHeaders({ email: getCurrentUserEmail(), oid: getCurrentUserOid(), accessToken: await getStorageApiAccessToken(scope) })`. `disarmCallSignals()` stops the timer, DELETEs the watch (best effort), disposes the machine. Keep all Electron/auth imports out of the pure core so esbuild's `--external:electron` build works.

- [ ] **Step 1: Write `scripts/verify-call-signals.ts`** driving the pure machine with fake timers (assert-based, like `scripts/verify-update-gate.ts` — read it first for the harness idiom). Scenarios: leave→pause+toast+grace; rejoin in grace→resume (signal-initiated only); manual-pause-then-leave→grace but **no** resume on rejoin; manual resume cancels grace; call_ended→stop; grace expiry→stop; duplicate seqs ignored; signals after done ignored.
- [ ] **Step 2: Run `npm run verify:call-signals`** → FAIL (module missing).
- [ ] **Step 3: Implement `src/main/call-signals.ts`.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: call-signal machine + storage poller (pause/grace/stop)"`

### Task 13: Wiring into recording lifecycle + toast routing + storage routes

**Files:**
- Modify: `src/main/recording-ipc.ts` (`handleRendererRecordingStarted`: after `sm.startAutoRecording(recording)` call `armCallSignals(recording)`; `handleRendererRecordingStopped` + `handleRendererRecordingError`: `disarmCallSignals()`; `setRecordingPaused(false)` path already exists — in the IPC handler where `recording:paused-changed` lands (find it in `index.ts`), call `callSignalsManualResume()` when `paused === false`)
- Modify: `src/main/index.ts` (`second-instance` switch: `upload-now` → machine's `onToastAction('upload-now')`; `resume-recording` → `onToastAction('resume-recording')`)
- Modify: `src/main/api-request-policy.ts` — extend `isStorageRoute` with the three call-watch paths:

```ts
    (req.method === 'POST' && path === '/api/v1/call-watch') ||
    (req.method === 'GET' && path === '/api/v1/call-watch/signals') ||
    (req.method === 'DELETE' && path === '/api/v1/call-watch')
```

  (Note: main's own poller mints headers directly; this addition matters only if any renderer-side call is ever added, and keeps the policy file the single truth for what counts as a storage route.)

- [ ] **Step 1: Wire it** (no new harness — the machine is already covered; wiring is thin).
- [ ] **Step 2: Run every existing verify script touched by these files** — at minimum `npm run verify:toast-xml`, `npm run verify:update-gate`, plus the repo's typecheck/lint (`npm run typecheck` / `npm run lint` — check `package.json` for exact names). Expected: PASS.
- [ ] **Step 3: Manual dev-loop smoke** (electron-vite: restart `npm run dev` after main changes — see CLAUDE.md): with `MN_CALL_SIGNALS_ENABLED=false`, confirm recording start/stop behaves exactly as before (feature dark).
- [ ] **Step 4: Commit** — `git commit -am "feat: arm call-signal poller on auto-recordings; toast verb routing"`

## Phase 4 — ops + live smoke

### Task 14: Production prerequisites + end-to-end smoke

**No code.** Checklist (spec "Ops prerequisites"):

- [ ] **Prod app registration** "Notetaker Meeting Events" — walk Joseph through it interactively (same portal steps as the 12 Aug spike registration: single tenant, no redirect URI, Application permission `OnlineMeetings.Read.All`, admin consent, client secret per org rotation standard). **Do not reuse the spike registration.**
- [ ] **Prod encryption cert**: `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "//CN=NotetakerCallWatch"` — PEMs go into app settings, files then deleted.
- [ ] **App settings** on `func-innov-nt-storage-prod` via portal/`az functionapp config appsettings set` (bicep is RBAC-only): the `NSA_*` table from Task 8, `NSA_CALL_WATCHES_ENABLED=true` **last**, after the smoke below passes on a test flag-on.
- [ ] **Deploy storage-api** via the existing GitHub Actions workflow; confirm `/health/live` and a manual `validationToken` handshake against `https://func-innov-nt-storage-prod-....azurewebsites.net/graph/call-notifications`.
- [ ] **Live smoke** on a packaged desktop build, one test meeting (organizer = the recorder): leave → pause + toast within ~15s; rejoin → auto-resume; leave and wait ~75s → auto-stop + upload + pipeline completes; second meeting: organizer "End meeting for all" → stop within ~15s. Verify subscription deleted after each stop (`GET /subscriptions` count = 0 via a throwaway app-token call, or App Insights logs).
- [ ] **Retire the spike**: Entra → App registrations → "Notetaker Meeting Call Events (Spike)" (client id `b817c14a-d200-4e24-806c-58f2c6c1d465`) → Delete; remove `spikes/meeting-call-events/.env`, `private_key.pem`, `cert.pem`; keep README + `events.jsonl`.
- [ ] **Fleet rollout** via the normal release + Intune/FIC ritual.

---

## Execution notes

- **TDD throughout**; each task's suite must be green before its commit. Storage-api: `python -m pytest -q` at repo root. Backend: `cd backend && python -m pytest -q`. Desktop: the named `verify:*` scripts.
- **Follow neighbours**: before writing any file, read the sibling it mirrors (`people.py` for relay routes, `meetings.py` for storage-api routers, `verify-update-gate.ts` for harnesses, `tests/conftest.py` idioms in each repo).
- **Privacy rule in every log line**: OIDs and hashes only — never join URLs, meeting titles, or emails (`hostGateLogContext` is the model).
- **Never** add a second unguarded `include_router` in `app/main.py` beyond the webhook sanctioned in Task 7.
