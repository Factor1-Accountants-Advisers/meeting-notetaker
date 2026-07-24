# Ad-hoc Attendee Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore optional employee selection for desktop ad-hoc recordings and use the persisted selections as meeting-scoped voiceprint candidates.

**Architecture:** Add a separate `manual_attendees` meeting field so manual hints cannot inherit Graph delivery semantics. A focused React picker collects locally known staff or typed emails, and both central and legacy voiceprint candidate builders consume the same persisted list.

**Tech Stack:** React 18, TypeScript, Electron IPC/FastAPI proxy, FastAPI, Pydantic, Python unittest, esbuild verification scripts.

---

### Task 1: Persist validated manual attendees

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routers/meetings.py`
- Modify: `src/renderer/src/lib/api.ts`
- Test: `backend/tests/test_meeting_owner_identity.py`

- [ ] **Step 1: Write failing schema and creation tests**

Add tests proving that `MeetingCreate` normalizes attendee emails, rejects
invalid email input and more than 49 entries, and that `create_meeting`
persists the selected attendees.

```python
body = MeetingCreate(
    title="Ad-hoc planning",
    source=MeetingSource.online,
    manual_attendees=[
        ManualMeetingAttendee(name="David A", email=" DAVID@factor1.com.au ")
    ],
)
self.assertEqual(body.manual_attendees[0].email, "david@factor1.com.au")
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\backend\.venv-win\Scripts\python.exe' `
  -m unittest backend.tests.test_meeting_owner_identity -v
```

Expected: import or field failures because `ManualMeetingAttendee` and
`manual_attendees` do not exist.

- [ ] **Step 3: Implement the minimal persisted model**

Add `ManualMeetingAttendee`, validate/normalize its email, add a
49-item-bounded list to `MeetingCreate` and `Meeting`, and pass the field
through `create_meeting`. Extend `MeetingDto` and `createMeeting` to serialize
the selected values.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all owner/creation tests pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/schemas.py backend/app/routers/meetings.py `
  backend/tests/test_meeting_owner_identity.py src/renderer/src/lib/api.ts
git commit -m "feat: persist manual meeting attendees"
```

### Task 2: Use manual attendees in both candidate paths

**Files:**
- Modify: `backend/app/services/meeting_voiceprints.py`
- Modify: `backend/app/services/speaker_matching.py`
- Test: `backend/tests/test_meeting_voiceprints.py`
- Test: `backend/tests/test_speaker_identity_matching.py`

- [ ] **Step 1: Write failing candidate-order tests**

Add a manual meeting with David and Benjamin selected, then assert central
candidate order is manual attendees, recorder, controlled expansion and that
case-insensitive duplicates are removed.

```python
self.assertEqual(
    [(item.email, item.source) for item in candidates],
    [
        ("david@factor1.com.au", "invitee"),
        ("benjamin@factor1.com.au", "invitee"),
        ("recorder@factor1.com.au", "recorder"),
    ],
)
```

Add the equivalent legacy matcher assertion over `Voiceprint` records.

- [ ] **Step 2: Run both focused modules and verify RED**

Run:

```powershell
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\backend\.venv-win\Scripts\python.exe' `
  -m unittest backend.tests.test_meeting_voiceprints `
  backend.tests.test_speaker_identity_matching -v
```

Expected: manual attendees are absent from both candidate sets.

- [ ] **Step 3: Implement minimal candidate wiring**

Add `meeting.manual_attendees` to the central builder with source `invitee`,
and to `_candidate_voiceprints_for_meeting` before the owner/recorder.
Preserve the current 50-candidate cap, normalization, and expansion behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: both modules pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/services/meeting_voiceprints.py `
  backend/app/services/speaker_matching.py `
  backend/tests/test_meeting_voiceprints.py `
  backend/tests/test_speaker_identity_matching.py
git commit -m "feat: use manual attendees for voiceprint lookup"
```

### Task 3: Preserve output and delivery semantics

**Files:**
- Modify: `backend/app/services/meeting_export.py`
- Test: `backend/tests/test_meeting_export.py`
- Test: `backend/tests/test_email_recipients.py`

- [ ] **Step 1: Write failing manual-output test**

Assert a manual meeting exports selected attendees in
`full_invitee_list` while retaining the existing manual meeting-type fallback.

```python
self.assertEqual(
    data["full_invitee_list"],
    [{"name": "David A", "email": "david@factor1.com.au", "response": None}],
)
self.assertEqual(data["meeting_type"], "internal")
```

Add a manual meeting with selected attendees to the recorder-only email test
so the safety rule is explicit.

- [ ] **Step 2: Run export and email modules and verify RED**

Run:

```powershell
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\backend\.venv-win\Scripts\python.exe' `
  -m unittest backend.tests.test_meeting_export `
  backend.tests.test_email_recipients -v
```

Expected: manual output contains no attendees before implementation.

- [ ] **Step 3: Add manual attendees to export only**

When Graph metadata is absent, build the invitee list from
`meeting.manual_attendees`. Do not change `_email_recipients` or manual
meeting-type classification.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: export and email tests pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/services/meeting_export.py `
  backend/tests/test_meeting_export.py backend/tests/test_email_recipients.py
git commit -m "feat: include manual attendees in meeting output"
```

### Task 4: Build the attendee picker and manual start wiring

**Files:**
- Create: `src/renderer/src/components/AttendeePicker.tsx`
- Modify: `src/renderer/src/screens/HomeScreen.tsx`
- Modify: `src/renderer/src/App.tsx`
- Create: `scripts/verify-ad-hoc-attendees.tsx`
- Modify: `package.json`

- [ ] **Step 1: Write the failing renderer verification**

Test exported picker helpers for trimmed email normalization, name/email
filtering, duplicate suppression, and the 49-person cap. Render the controlled
picker and Home screen to verify the optional label, selected chip, remove
action, and disabled state.

```tsx
assert.deepEqual(
  addAttendee([], { name: "David", email: " DAVID@factor1.com.au " }),
  [{ name: "David", email: "david@factor1.com.au" }]
)
```

- [ ] **Step 2: Run verification and verify RED**

Run:

```powershell
npm run verify:ad-hoc-attendees
```

Expected: script or exported picker module is missing.

- [ ] **Step 3: Implement the focused picker**

Build a controlled, token-styled picker with:

- local `fetchPeople()` suggestions through `useLive`
- enrolled-staff filtering
- typed valid-email addition
- removable selected chips
- keyboard Enter support
- clear validation/cap copy
- disabled behavior during recording

Change `HomeScreen.onStartRecording` and `startManualRecording` to carry the
selected array into `createMeeting`.

- [ ] **Step 4: Run renderer verification and TypeScript checks**

Run:

```powershell
npm run verify:ad-hoc-attendees
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/src/components/AttendeePicker.tsx `
  src/renderer/src/screens/HomeScreen.tsx src/renderer/src/App.tsx `
  scripts/verify-ad-hoc-attendees.tsx package.json
git commit -m "feat: restore ad-hoc attendee picker"
```

### Task 5: Full verification and evidence

**Files:**
- Modify: `docs/jira-progress.md`

- [ ] **Step 1: Run the complete backend suite**

```powershell
$env:PYTHONPATH='backend'
& 'C:\Projects\meeting-notetaker-2\backend\.venv-win\Scripts\python.exe' `
  -m unittest discover -s backend/tests -t backend -v
```

Expected: all tests pass.

- [ ] **Step 2: Run desktop and contract verification**

```powershell
npm run verify:ad-hoc-attendees
npm run verify:storage-cutover
npm run verify:graph
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass with no whitespace errors.

- [ ] **Step 3: Review delivery isolation**

Inspect the final diff and explicitly confirm:

- manual attendees are not read by `_email_recipients`
- manual attendees do not alter `store.ACCESS`
- renderer performs no direct network request
- no token, OID, voiceprint, or private employee export is logged

- [ ] **Step 4: Record verified evidence**

Add a concise `docs/jira-progress.md` entry mapping the restored IN-64 /
IN-123 / IN-126 manual attendee flow to the implementation commits and test
results. Do not update Jira without separate authorization.

- [ ] **Step 5: Commit**

```powershell
git add docs/jira-progress.md
git commit -m "docs: record ad-hoc attendee picker evidence"
```
