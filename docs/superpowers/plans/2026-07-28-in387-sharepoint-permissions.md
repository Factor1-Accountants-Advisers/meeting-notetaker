# IN-387 SharePoint Permission Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing SharePoint transcript-save flow the ability to grant view-only access to calendar/manual attendees (and the organizer), atomically with the upload, without changing file naming, folder location behavior, or the manual trigger — those stay exactly as they are today pending IN-385/391.

**Architecture:** `backend/app/services/sharepoint.py` gains one new primitive (`grant_view`, a Graph `invite` action call) alongside the existing `save_transcript` primitive, whose return type grows a Graph item ID so `grant_view` has something to target. `backend/app/routers/meetings.py` gains one new pure function (`_sharepoint_recipients`, mirroring the existing `_email_recipients` pattern already in that file) and calls both `save_transcript` and `grant_view` back-to-back inside the *existing* try/except in `save_transcript_to_sharepoint` — no new atomicity mechanism, it reuses the try/except that's already there.

**Tech Stack:** Python 3.11, FastAPI, `unittest` (stdlib), `urllib.request` for the Graph HTTP calls (matching the existing style in `sharepoint.py` — no new HTTP library).

**Spec:** `docs/superpowers/specs/2026-07-28-in387-sharepoint-library-design.md`

---

## Before you start

Read `docs/superpowers/specs/2026-07-28-in387-sharepoint-library-design.md` in full — it has the reasoning behind every decision below (why atomic-not-split, why the organizer needs an explicit add, why missing emails are skipped not fatal). This plan implements that spec's Scope items 1-4 only. Items 5-6 (discovering the real Transcriptions library drive ID, and the live write/permission smoke test) require an interactive Graph sign-in against the production tenant and are **out of scope for this plan** — they stay as documented follow-up work, exactly as the spec's "Definition of done" section says.

Run the full suite once before touching anything, to confirm your baseline:

```bash
cd meeting-notetaker-2
PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -t backend -v
```

Expected: `Ran 228 tests`. **Known pre-existing flake, unrelated to this plan:** `test_stub_serializes_concurrent_exports_for_one_meeting` in `backend/tests/test_storage_api_meetings.py` fails intermittently (confirmed flaky as of 28 July 2026 — 3 consecutive runs gave 11/14/8 vs. an expected 15 on `assertEqual(len(list((meeting_dir / "history").glob("*.json"))), 15)`, a filesystem-timing race in concurrent history-file writes). If your baseline run shows exactly this one failure, that's expected — proceed. Any *other* failure, or this same failure with a materially different assertion message, means something else changed on `main` since this plan was written; stop and figure out what before continuing.

---

### Task 1: Give `save_transcript` an item ID so permissions have something to target

**Files:**
- Modify: `backend/app/services/sharepoint.py`
- Test: `backend/tests/test_sharepoint_provider.py`

Right now `GraphSharePointProvider.save_transcript` returns a bare `str` (the `webUrl`). Graph's upload response also includes an `id` field for the created/updated item, which the next task's `grant_view` call needs in its URL (`/drives/{drive-id}/items/{item-id}/invite`). This task threads that id through without changing any existing caller's behavior beyond the return shape.

- [ ] **Step 1: Write the failing test — update existing Graph provider tests for the new return shape**

Open `backend/tests/test_sharepoint_provider.py`. Replace the `_Response.read()` fixture and the two existing Graph tests' assertions:

```python
class _Response:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(
            {"webUrl": "https://sharepoint.example/transcript.txt", "id": "item-abc-123"}
        ).encode("utf-8")
```

```python
    async def test_graph_provider_uploads_to_library_root_when_folder_path_empty(self):
        meeting = Meeting(
            id=uuid4(),
            title="Root upload",
            source=MeetingSource.online,
            owner_id="joseph@example.com",
            created_at=datetime.now(timezone.utc),
        )
        captured_urls = []

        def fake_urlopen(req, timeout=0):
            captured_urls.append(req.full_url)
            return _Response()

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            result = await provider.save_transcript(
                meeting=meeting,
                filename="minutes.txt",
                content="transcript",
                access_token="token",
            )

        self.assertEqual(result.web_url, "https://sharepoint.example/transcript.txt")
        self.assertEqual(result.item_id, "item-abc-123")
        self.assertEqual(
            captured_urls,
            ["https://graph.microsoft.com/v1.0/drives/drive-123/root:/minutes.txt:/content"],
        )
```

Leave `test_graph_provider_uploads_to_configured_subfolder` and
`test_provider_factory_uses_graph_when_drive_id_is_set_and_folder_path_empty`
as-is (they don't inspect the return value).

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_sharepoint_provider -v` (from `meeting-notetaker-2/backend`, or use the discover form from the repo root filtered with `-k`)
Expected: FAIL — `AttributeError: 'str' object has no attribute 'web_url'`

- [ ] **Step 3: Implement the minimal change**

In `backend/app/services/sharepoint.py`:

1. Change the existing `from typing import Protocol` line to
   `from typing import NamedTuple, Protocol`, and add this class definition
   after the imports, before `SharePointProvider`:

```python
class SharePointUploadResult(NamedTuple):
    web_url: str
    item_id: str
```

2. Update the `SharePointProvider` Protocol's `save_transcript` return annotation from `-> str` to `-> SharePointUploadResult`.

3. Update `LocalSharePointProvider.save_transcript` (currently returns `path.as_uri()`):

```python
        LOCAL_SHAREPOINT_DIR.mkdir(parents=True, exist_ok=True)
        path = LOCAL_SHAREPOINT_DIR / filename
        path.write_text(content, encoding="utf-8")
        logger.info("local SharePoint transcript saved for %s: %s", meeting.id, path)
        return SharePointUploadResult(web_url=path.as_uri(), item_id=str(path))
```

4. Update `GraphSharePointProvider.save_transcript`'s tail (currently ends by returning `web_url`):

```python
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        web_url = body.get("webUrl")
        if not isinstance(web_url, str) or not web_url:
            raise RuntimeError("Graph upload completed but returned no webUrl")
        item_id = body.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise RuntimeError("Graph upload completed but returned no item id")
        logger.info("SharePoint transcript saved for %s", meeting.id)
        return SharePointUploadResult(web_url=web_url, item_id=item_id)
```

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Run the full suite to check for other breakage**

Run the full-suite command from "Before you start".
Expected: the known pre-existing `test_stub_serializes_concurrent_exports_for_one_meeting` flake from "Before you start" (unrelated, ignore it), plus `test_delivery_reliability.py`'s `CaptureSharePointProvider` and its `test_sharepoint_save_writes_transcript_and_records_location` will very likely now fail too (it returns a bare string, and the router will break trying to read `.web_url`/`.item_id` off it) — that's expected and is fixed in Task 4. Confirm the *only new* failures beyond the known flake are in `test_delivery_reliability.py`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/sharepoint.py backend/tests/test_sharepoint_provider.py
git commit -m "feat: return Graph item id from SharePoint upload (IN-387)"
```

---

### Task 2: Add the `grant_view` Graph permission primitive

**Files:**
- Modify: `backend/app/services/sharepoint.py`
- Test: `backend/tests/test_sharepoint_provider.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_sharepoint_provider.py`:

```python
    async def test_graph_provider_grants_view_access_to_recipients(self):
        captured = {}

        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Response()

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            await provider.grant_view(
                item_id="item-abc-123",
                recipients=["bb@factor1.com.au", "jt@factor1.com.au"],
                access_token="token",
            )

        self.assertEqual(
            captured["url"],
            "https://graph.microsoft.com/v1.0/drives/drive-123/items/item-abc-123/invite",
        )
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["body"]["roles"], ["read"])
        self.assertEqual(captured["body"]["sendInvitation"], False)
        self.assertEqual(
            captured["body"]["recipients"],
            [{"email": "bb@factor1.com.au"}, {"email": "jt@factor1.com.au"}],
        )

    async def test_graph_provider_grant_view_is_noop_for_empty_recipients(self):
        def fake_urlopen(req, timeout=0):
            raise AssertionError("should not call Graph when there are no recipients")

        provider = GraphSharePointProvider("drive-123", "")
        with patch("urllib.request.urlopen", fake_urlopen):
            await provider.grant_view(item_id="item-abc-123", recipients=[], access_token="token")

    async def test_graph_provider_grant_view_requires_token(self):
        provider = GraphSharePointProvider("drive-123", "")
        with self.assertRaises(ValueError):
            await provider.grant_view(
                item_id="item-abc-123", recipients=["bb@factor1.com.au"], access_token=None
            )

    async def test_local_provider_grant_view_is_noop(self):
        provider = sharepoint.LocalSharePointProvider()
        # Should not raise even with no real permission system behind it.
        await provider.grant_view(
            item_id="anything", recipients=["bb@factor1.com.au"], access_token=None
        )
```

Add `LocalSharePointProvider` to the imports at the top of the test file if not already present as `sharepoint.LocalSharePointProvider` (it's accessed via the `sharepoint` module import already used by `test_provider_factory_uses_graph_when_drive_id_is_set_and_folder_path_empty`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_sharepoint_provider -v`
Expected: FAIL — `AttributeError: 'GraphSharePointProvider' object has no attribute 'grant_view'` (and same for `LocalSharePointProvider`).

- [ ] **Step 3: Implement the minimal code**

In `backend/app/services/sharepoint.py`, add to the `SharePointProvider` Protocol:

```python
    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> None:
        ...
```

Add to `LocalSharePointProvider`:

```python
    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> None:
        """Local stub mode has no real permission system; nothing to grant."""
        return
```

Add to `GraphSharePointProvider`:

```python
    async def grant_view(
        self,
        *,
        item_id: str,
        recipients: list[str],
        access_token: str | None = None,
    ) -> None:
        if not recipients:
            return
        if not access_token:
            raise ValueError("SharePoint permission grant requires a delegated Graph token")
        url = f"{GRAPH_DRIVE_BASE}/{self._drive_id}/items/{item_id}/invite"
        payload = {
            "recipients": [{"email": email} for email in recipients],
            "requireSignIn": True,
            "sendInvitation": False,
            "roles": ["read"],
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        logger.info(
            "SharePoint view access granted for item %s to %d recipient(s)",
            item_id,
            len(recipients),
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run the same command as Step 2.
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/sharepoint.py backend/tests/test_sharepoint_provider.py
git commit -m "feat: add SharePoint view-access grant via Graph invite action (IN-387)"
```

---

### Task 3: Resolve who gets view access — `_sharepoint_recipients`

**Files:**
- Modify: `backend/app/routers/meetings.py`
- Create: `backend/tests/test_sharepoint_recipients.py`

This mirrors the existing `_email_recipients` (same file, ~line 728) but is **not** the same function — email currently ignores `manual_attendees` entirely (see `test_adhoc_recording_still_emails_recorder_only` in `test_email_recipients.py`, which asserts manual attendees are dropped); IN-387's design explicitly wants manual attendees included for SharePoint view access. Do not reuse or refactor `_email_recipients` — write a separate function, matching the codebase's existing convention of one recipient-resolution function per delivery channel.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_sharepoint_recipients.py`:

```python
"""IN-387: who gets view access to a meeting's SharePoint files.

Organiser must be included explicitly — Graph's attendees array excludes the
organiser, the same gap already fixed for email in IN-94/IN-119
(test_email_recipients.py). Unlike email (which currently drops manual
attendees, see test_adhoc_recording_still_emails_recorder_only), manual/ad-hoc
attendees ARE granted SharePoint view access here — that's an intentional
IN-387 behavior difference from email, not an oversight.
"""

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from app.routers.meetings import _sharepoint_recipients
from app.schemas import (
    GraphMeetingAttendeeMetadata,
    GraphMeetingMetadata,
    ManualMeetingAttendee,
    Meeting,
    MeetingSource,
)


def _meeting(graph_metadata=None, source=MeetingSource.online, manual_attendees=None):
    return Meeting(
        id=uuid4(),
        title="Test",
        source=source,
        owner_id="organizer@factor1.com.au",
        created_at=datetime.now(timezone.utc),
        graph_metadata=graph_metadata,
        manual_attendees=manual_attendees or [],
    )


class SharePointRecipientTests(unittest.TestCase):
    def test_calendar_meeting_includes_organizer_not_in_attendees(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-1",
            organizer_email="organizer@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email="bb@factor1.com.au"),
                GraphMeetingAttendeeMetadata(email="jt@factor1.com.au"),
            ],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertIn("organizer@factor1.com.au", recipients)
        self.assertIn("bb@factor1.com.au", recipients)
        self.assertIn("jt@factor1.com.au", recipients)

    def test_organizer_not_duplicated_when_also_an_attendee(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-2",
            organizer_email="organizer@factor1.com.au",
            attendees=[GraphMeetingAttendeeMetadata(email="Organizer@Factor1.com.au")],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertEqual(recipients.count("organizer@factor1.com.au"), 1)

    def test_calendar_attendee_with_missing_email_is_skipped_not_fatal(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-3",
            organizer_email="organizer@factor1.com.au",
            attendees=[
                GraphMeetingAttendeeMetadata(email=None),  # e.g. a room resource
                GraphMeetingAttendeeMetadata(email="jt@factor1.com.au"),
            ],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        # Attendees are processed before the organiser is added (matching
        # _email_recipients' order), so a valid attendee lands first and the
        # organiser last — not alphabetical or input order.
        self.assertEqual(
            recipients,
            ["jt@factor1.com.au", "organizer@factor1.com.au"],
        )

    def test_all_calendar_attendees_missing_email_still_succeeds_empty(self):
        meta = GraphMeetingMetadata(
            meeting_id="evt-4",
            organizer_email=None,
            attendees=[GraphMeetingAttendeeMetadata(email=None)],
        )
        recipients = _sharepoint_recipients(_meeting(meta))
        self.assertEqual(recipients, [])

    def test_manual_recording_uses_manual_attendees(self):
        recipients = _sharepoint_recipients(
            _meeting(
                None,
                source=MeetingSource.in_person,
                manual_attendees=[
                    ManualMeetingAttendee(name="David Ahlhaus", email="davidahlhaus@factor1.com.au"),
                    ManualMeetingAttendee(name="Benjamin Bryant", email="benjaminbryant@factor1.com.au"),
                ],
            )
        )
        self.assertEqual(
            recipients,
            ["davidahlhaus@factor1.com.au", "benjaminbryant@factor1.com.au"],
        )

    def test_manual_recording_with_no_attendees_succeeds_empty(self):
        recipients = _sharepoint_recipients(_meeting(None, source=MeetingSource.in_person))
        self.assertEqual(recipients, [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_sharepoint_recipients -v`
Expected: FAIL — `ImportError: cannot import name '_sharepoint_recipients'`

- [ ] **Step 3: Implement the minimal code**

In `backend/app/routers/meetings.py`, add directly after `_email_recipients` (after line 759):

```python
def _sharepoint_recipients(meeting: Meeting) -> list[str]:
    """Resolve Jira IN-387 SharePoint view-access recipients.

    Calendar-linked recordings grant view access to Graph attendee emails plus
    the organiser (Graph's ``attendees`` array excludes the organiser, the
    same gap fixed for email in IN-94/IN-119 — see ``_email_recipients``).
    Manual/ad-hoc recordings grant view access to the recorder's ad-hoc
    attendee picker selections instead. Recipients with no usable email
    (room/resource attendees, unresolved external attendees) are silently
    skipped rather than failing delivery. The recording owner is not included
    here: they already have access as the identity that performed the
    upload. Preserve first-seen order while deduping case-insensitively.
    """
    recipients: list[str] = []

    def _add(candidate: str | None) -> None:
        email = _normalise_email(candidate)
        if email and email not in recipients:
            recipients.append(email)

    if meeting.graph_metadata:
        for attendee in meeting.graph_metadata.attendees:
            _add(attendee.email)
        _add(meeting.graph_metadata.organizer_email)
    else:
        for attendee in meeting.manual_attendees:
            _add(attendee.email)

    return recipients
```

- [ ] **Step 4: Run tests to verify they pass**

Run the same command as Step 2.
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/meetings.py backend/tests/test_sharepoint_recipients.py
git commit -m "feat: resolve SharePoint view-access recipients (IN-387)"
```

---

### Task 4: Wire it into the atomic delivery path

**Files:**
- Modify: `backend/app/routers/meetings.py` (`save_transcript_to_sharepoint`, ~line 633)
- Modify: `backend/tests/test_delivery_reliability.py`

This is the integration point the spec calls out by name: upload and permission-granting must share the existing `saving`/`saved`/`failed` state transitions and the existing single try/except, not a separate helper with its own status tracking.

- [ ] **Step 1: Write the failing tests — update the fixture and existing test, add a new one**

In `backend/tests/test_delivery_reliability.py`, replace `CaptureSharePointProvider`:

```python
class CaptureSharePointProvider:
    def __init__(self, uploads, grants, fail_grant=False):
        self.uploads = uploads
        self.grants = grants
        self.fail_grant = fail_grant

    async def save_transcript(self, *, meeting, filename, content, access_token=None):
        self.uploads.append({"meeting": meeting, "filename": filename, "content": content, "token": access_token})
        return sharepoint.SharePointUploadResult(
            web_url=f"https://sharepoint.example/{filename}",
            item_id="item-test-1",
        )

    async def grant_view(self, *, item_id, recipients, access_token=None):
        if self.fail_grant:
            raise RuntimeError("simulated Graph invite failure")
        self.grants.append({"item_id": item_id, "recipients": recipients, "token": access_token})
```

Add `from app.services import sharepoint` to this test file's imports if not already present.

Update `test_sharepoint_save_writes_transcript_and_records_location` to also assert the grant was called (this meeting has no `graph_metadata` and no `manual_attendees`, so recipients will be empty — assert that explicitly, since an empty-recipients grant call is still expected to happen so the "no-op inside `grant_view`, not skipped by the router" contract is exercised):

```python
    async def test_sharepoint_save_writes_transcript_and_records_location(self):
        uploads = []
        grants = []
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(uploads, grants)

        result = await meetings_router.save_transcript_to_sharepoint(
            self.meeting_id,
            actor="Joseph",
            graph_token="token",
        )

        self.assertEqual(result.sharepoint_status, SharePointStatus.saved)
        self.assertEqual(result.sharepoint_web_url, store.MEETINGS[self.meeting_id].sharepoint_web_url)
        self.assertEqual(store.MEETINGS[self.meeting_id].sharepoint_status, SharePointStatus.saved)
        self.assertEqual(store.MEETINGS[self.meeting_id].sharepoint_error_message, None)
        self.assertEqual(len(uploads), 1)
        self.assertIn("--- TRANSCRIPT ---", uploads[0]["content"])
        self.assertIn("Summary survives delivery failure.", uploads[0]["content"])
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]["item_id"], "item-test-1")
        self.assertEqual(grants[0]["recipients"], [])
```

Add a new test proving atomicity — a grant failure marks the whole delivery `failed`, and a subsequent retry re-runs both steps:

```python
    async def test_sharepoint_grant_failure_marks_whole_delivery_failed_and_retry_recovers(self):
        uploads = []
        grants = []
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(
            uploads, grants, fail_grant=True
        )

        with self.assertRaises(HTTPException) as raised:
            await meetings_router.save_transcript_to_sharepoint(
                self.meeting_id,
                actor="Joseph",
                graph_token="token",
            )
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(store.MEETINGS[self.meeting_id].sharepoint_status, SharePointStatus.failed)
        self.assertIn("simulated Graph invite failure", store.MEETINGS[self.meeting_id].sharepoint_error_message or "")
        self.assertEqual(len(uploads), 1)
        self.assertEqual(len(grants), 0)

        # Retry with a working provider re-runs both steps from scratch.
        meetings_router.get_sharepoint_provider = lambda token=None: CaptureSharePointProvider(uploads, grants)
        result = await meetings_router.save_transcript_to_sharepoint(
            self.meeting_id,
            actor="Joseph",
            graph_token="token",
        )
        self.assertEqual(result.sharepoint_status, SharePointStatus.saved)
        self.assertEqual(len(uploads), 2)
        self.assertEqual(len(grants), 1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_delivery_reliability -v`
Expected: FAIL — either an `AttributeError` (router still calling the old bare-string-returning path) or `AssertionError: 0 != 1` on the `grants` list (grant never called), depending on exactly what Task 1 left in place.

- [ ] **Step 3: Implement the minimal code**

In `backend/app/routers/meetings.py`, update `save_transcript_to_sharepoint` (the `try` block currently at lines 677-697):

```python
    try:
        upload = await get_sharepoint_provider(graph_token or None).save_transcript(
            meeting=meeting,
            filename=filename,
            content=transcript_text,
            access_token=graph_token or None,
        )
        recipients = _sharepoint_recipients(meeting)
        await get_sharepoint_provider(graph_token or None).grant_view(
            item_id=upload.item_id,
            recipients=recipients,
            access_token=graph_token or None,
        )
    except Exception as exc:
        logger.exception("SharePoint transcript save failed for %s", meeting_id)
        current = store.MEETINGS[meeting_id]
        store.MEETINGS[meeting_id] = current.model_copy(
            update={
                "sharepoint_status": SharePointStatus.failed,
                "sharepoint_error_message": f"SharePoint save failed: {exc}",
            }
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"SharePoint save failed: {exc}",
        )
```

And update the success block right after it — **both** the `model_copy` update dict AND the `store.add_audit` call below it reference the old bare `web_url` variable, which no longer exists once Task 1 renamed it to the `upload` tuple. Miss the `add_audit` line and you'll get a `NameError: name 'web_url' is not defined` on every successful save, since `try`/`except` around the upload+grant calls has already exited by the time this code runs. The current code (unchanged by earlier tasks) is:

```python
    current = store.MEETINGS[meeting_id]
    updated = current.model_copy(
        update={
            "sharepoint_status": SharePointStatus.saved,
            "sharepoint_error_message": None,
            "sharepoint_web_url": web_url,
        }
    )
    store.MEETINGS[meeting_id] = updated
    store.add_audit(
        actor,
        "meeting.sharepoint_save",
        meeting.title,
        after=web_url,
        meeting_id=meeting_id,
    )
```

Replace it with:

```python
    current = store.MEETINGS[meeting_id]
    updated = current.model_copy(
        update={
            "sharepoint_status": SharePointStatus.saved,
            "sharepoint_error_message": None,
            "sharepoint_web_url": upload.web_url,
        }
    )
    store.MEETINGS[meeting_id] = updated
    store.add_audit(
        actor,
        "meeting.sharepoint_save",
        meeting.title,
        after=upload.web_url,
        meeting_id=meeting_id,
    )
```

(Only `web_url` → `upload.web_url` changes, in both places — nothing else in this block moves.)

Note: `get_sharepoint_provider(graph_token or None)` is called twice (once for the upload, once for the grant) purely because that's how the existing code already resolves the provider — check `get_sharepoint_provider`'s implementation (`sharepoint.py`) before assuming this is wasteful: it's a plain function that returns a new stateless provider instance each call (no caching, no connection to close), so calling it twice has no observable cost or side effect. If a future reviewer flags this as duplication, resolving it once into a local variable is a safe simplification, but it isn't required for correctness.

- [ ] **Step 4: Run tests to verify they pass**

Run the same command as Step 2.
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Run the full suite**

Run the full-suite command from "Before you start".
Expected: `Ran 239 tests` (228 baseline + 4 from Task 2 + 6 from Task 3 + 1 new test this task adds) with no failures other than the known pre-existing `test_stub_serializes_concurrent_exports_for_one_meeting` flake noted in "Before you start". Recount if it doesn't match exactly, but any *new* failure beyond that one flake means something in this task's changes is wrong — do not proceed to Step 6 until it's just that one known flake or nothing.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/meetings.py backend/tests/test_delivery_reliability.py
git commit -m "feat: grant SharePoint view access atomically with upload (IN-387)"
```

---

### Task 5: Point the default folder path at the library root

**Files:**
- Modify: `backend/app/config.py`

The library is flat (per spec's approved folder-structure decision) — files belong at the library root, not under a `"Notetaker Transcripts"` subfolder. `GraphSharePointProvider` already treats an empty folder path as root-relative (proven by the existing `test_graph_provider_uploads_to_library_root_when_folder_path_empty` test from Task 1) — this task only changes the default value, no provider code changes.

Do **not** change `sharepoint_drive_id`'s default here — it stays `""` until a human completes the drive-ID discovery step in the spec's "Open items" (out of scope for this plan).

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_sharepoint_provider.py` (or wherever a config-defaults test already lives — check for one first; if none exists, add near the bottom of `test_sharepoint_provider.py`):

```python
    def test_folder_path_default_is_library_root(self):
        from app.config import Settings

        self.assertEqual(Settings().sharepoint_folder_path, "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest tests.test_sharepoint_provider -v`
Expected: FAIL — `AssertionError: 'Notetaker Transcripts' != ''`

- [ ] **Step 3: Implement the minimal change**

In `backend/app/config.py`, change:

```python
    sharepoint_folder_path: str = "Notetaker Transcripts"
```

to:

```python
    sharepoint_folder_path: str = ""
```

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run the full-suite command from "Before you start".
Expected: no failures other than the known pre-existing `test_stub_serializes_concurrent_exports_for_one_meeting` flake from "Before you start" (no other test asserts the old `"Notetaker Transcripts"` default — confirm this with a quick search before committing: `grep -rn "Notetaker Transcripts" backend/` should return nothing after this change other than possibly a comment, which is fine to leave or update).

- [ ] **Step 6: Commit**

```bash
git add backend/app/config.py backend/tests/test_sharepoint_provider.py
git commit -m "fix: default SharePoint uploads to library root, not a subfolder (IN-387)"
```

---

### Task 6: Record implementation evidence and remaining open items

**Files:**
- Modify: `docs/jira-progress.md`

Matches this repo's existing convention (see the IN-386 and IN-477 entries already in this file) of recording what shipped, what was verified, and what's still open, in the same reverse-chronological log.

- [ ] **Step 1: Add an entry**

Add near the top of `docs/jira-progress.md` (before the existing IN-386 entry), following the existing entries' style:

```markdown
- [ ] IN-387 — Define SharePoint library structure and provisioning
  - **Implemented (see docs/superpowers/specs/2026-07-28-in387-sharepoint-library-design.md):**
    site/library identified (`futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems`,
    library `Transcriptions`, per IN-91's 3 Jul comment clearing use of the
    current directory), flat folder structure, owner-implicit/invitee-view
    permission model, `GraphSharePointProvider.grant_view` (Graph `invite`
    action) wired atomically into the existing `save_transcript_to_sharepoint`
    upload/retry path, `_sharepoint_recipients` resolving calendar attendees
    + organiser or manual/ad-hoc attendees, and the folder-path default
    switched to library root. Verification: full backend suite passed
    (record actual test count here once run), `test_sharepoint_provider.py`,
    `test_sharepoint_recipients.py`, and `test_delivery_reliability.py` cover
    the new behavior including atomic failure/retry.
  - **Still open (spec's Scope items 5-6, requires a human, interactive
    Graph sign-in against the production tenant):** the real Transcriptions
    library's Graph drive ID has not been discovered or configured
    (`sharepoint_drive_id` remains `""`/stub mode), and no live write-access
    or permission-grant smoke test has been run. Until both are done, this
    ticket is not deployable/functionally complete even though its code and
    tests are.
```

- [ ] **Step 2: Commit**

```bash
git add docs/jira-progress.md
git commit -m "docs: record IN-387 implementation evidence and open items"
```

---

## After all tasks

Run the full suite one final time and confirm `Ran 239 tests` with no failures other than the known pre-existing `test_stub_serializes_concurrent_exports_for_one_meeting` flake (see "Before you start"):

```bash
PYTHONPATH=backend backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -t backend -v
```

This plan does not push to `origin` or touch production configuration — per the spec, `sharepoint_drive_id` is left unset, so none of this can reach the real SharePoint library until a human completes the two open items in Task 6's entry and updates that config value. Do not set `sharepoint_drive_id` to a guessed or placeholder-real-looking value at any point in this plan.
