# IN-387 SharePoint Library Structure & Provisioning Design

**Date:** 28 July 2026
**Jira:** IN-387
**Parent:** IN-375
**Status:** Approved in conversation; implementation not started

## Goal

Define and confirm the SharePoint site, document library, folder structure,
file-naming convention, and permission model that IN-385 (writing summary and
transcript files) will deliver into, and add the Graph capability needed to
grant per-recipient view access to those files. This ticket is the
"foundation" step, analogous to how IN-471 established the Storage API before
IN-377/378/381/386 built on it.

## Authorities

- Jira IN-387 (this ticket) and its blocker IN-91.
- IN-91 comment thread (David Ahlhaus, 30 Jun-13 Jul 2026): the target
  document library is
  `https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/Transcriptions/`,
  already provisioned ("We have a new document store which we can use to
  store transcriptions" — 30 Jun). A separate dedicated org-level store was
  requested from IT but deferred to a later slice (13 Jul: "Deferred to Slice
  2... Lets continue to implement with current directory" — 3 Jul). IN-91's
  formal "Blocked" status tracks that future org-level migration, not access
  to the current library, which David explicitly cleared for use.
- Jira IN-385 (downstream, also Joseph): fixes the file-naming convention —
  `[YYYY-MM-DD] [Meeting Title] - Summary.md` and
  `[YYYY-MM-DD] [Meeting Title] - Transcript.md` — and requires Graph Files
  API delivery with view permissions for all invitees.
- Existing Slice 1 code: `backend/app/services/sharepoint.py`
  (`GraphSharePointProvider`, `LocalSharePointProvider`),
  `backend/app/schemas.py` (`SharePointStatus` enum), and the manual
  `POST /{meeting_id}/sharepoint` endpoint in
  `backend/app/routers/meetings.py`. `src/main/auth-msal.ts`
  (`GRAPH_SHAREPOINT_SCOPES = ['User.Read', 'Files.ReadWrite.All']`).

## Scope

1. Confirm the target site/library identity and discover its Graph drive ID
   (manual step, see "Open items" below — cannot be done without an
   interactive sign-in).
2. Define the folder structure: flat, no subfolders. All meeting files live
   directly in the library root.
3. Define the permission model: recording owner needs no explicit grant
   (they write under their own signed-in identity and already have creator
   access); invitees/attendees get an explicit view-only grant.
4. Add a Graph "grant view access" capability to the SharePoint service layer
   (an `invite` action call), usable by both calendar and manual/ad-hoc
   recordings, **wired into the existing atomic delivery path** in
   `save_transcript_to_sharepoint` (`backend/app/routers/meetings.py`) so
   that upload and permission-granting share one `SharePointStatus`
   transition and one retry — not a disconnected helper method called from
   nowhere.
5. Update configuration defaults (`sharepoint_drive_id`,
   `sharepoint_folder_path`) once the real drive ID is known.
6. Confirm live write access and permission-granting against the real
   library with a delegated token (manual smoke, not automated).

**Definition of done for this ticket:** items 1-4 (identity confirmed,
structure/naming/permission model documented, and the `invite` capability
implemented and unit-tested) are the mergeable deliverable. Items 5-6 are
gated on a human completing the interactive drive-ID lookup and cannot be
finished in the same sitting as 1-4; they are tracked as an explicit,
documented follow-up rather than blocking the rest of the ticket from being
considered complete.

## Out of scope

- Writing the two files (summary + transcript) themselves — IN-385.
- Deciding when delivery is triggered (manual button vs. automatic at
  pipeline-ready) — IN-385's call; this design does not presuppose either.
- Creating a new document library — "Transcriptions" already exists.
- The future dedicated org-level document store (IN-91's unresolved half) —
  out of scope until IT provisions it.
- Any change to voiceprint-related use of `manual_attendees` — reused
  read-only here, not modified.

## Site & library

- Site: `futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems`
- Library: `Transcriptions`
- The library's Graph drive ID is not yet known in this repo or session and
  must be discovered via
  `GET /sites/{hostname}:/sites/InnovationsandSystems:/drives` with a
  delegated token that has access, matched by `name == "Transcriptions"`.
  This is a non-secret identifier once found (comparable to how
  `MN_STORAGE_API_URL` is a hardcoded public default in `src/main/env.ts`),
  safe to commit as a default once confirmed.

## Folder structure

Flat. No per-meeting or per-month subfolders. IN-385's filename convention
already embeds date and title, which is sufficient for sorting and search
without folder nesting. All Summary/Transcript files for every meeting sit
directly under the library root.

## Permission model

| Party | Access | Source of identity |
|---|---|---|
| Recording owner | Implicit (creator access from the identity used to upload) | The signed-in user whose delegated token performed the write |
| Calendar meeting invitees | View only | `meeting.attendees[].email` (`GraphMeetingAttendeeMetadata`, already on the Meeting model) |
| Manual/ad-hoc recording attendees | View only | `meeting.manual_attendees[].email` (`ManualMeetingAttendee`, already on the Meeting model, originally added for voiceprint hints) |

No party other than the owner receives edit access. Grants use Microsoft
Graph's `POST /drives/{drive-id}/items/{item-id}/invite` action with
`roles: ["read"]` and `sendInvitation: false` (a silent direct grant — no
email is sent). This action is believed covered by the delegated
`Files.ReadWrite.All` scope the desktop already requests via
`GRAPH_SHAREPOINT_SCOPES` (`src/main/auth-msal.ts`) — no new Azure AD app
permission or admin consent is expected to be required, but this must be
confirmed against the actual tenant during implementation (some tenant
configurations require `Sites.ReadWrite.All` for the `invite` action on a
SharePoint-backed drive specifically); do not treat "no new permission
needed" as settled until the live smoke test in "Testing" confirms it.

**Recipients with no usable email are skipped, not a failure.** If a manual
recording has an empty `manual_attendees` list, delivery still succeeds with
only the owner having access — this is not a failure case.
(`ManualMeetingAttendee` already requires a valid email per its existing
validator, so a malformed-email failure mode does not arise for manual
attendees.) Calendar attendees are different: `GraphMeetingAttendeeMetadata.email`
is `str | None` and is not guaranteed populated (rooms, resources, and
unresolved external attendees commonly have no email). When building the
invite recipient list, skip any calendar attendee whose `email` is `None` or
blank — do not fail the whole delivery over it. This is the same
degraded-but-successful behavior as the empty-manual-attendees case, applied
consistently to both recipient sources.

**The organizer must be included explicitly, not assumed to be in
`attendees[]`.** Graph's `attendees` array excludes the meeting organizer —
this codebase already hit exactly this gap for email delivery
(`_email_recipients` in `backend/app/routers/meetings.py`, fixed for
IN-94/IN-119) and had to add the organizer back in by hand. If the recording
owner (the signed-in uploader) differs from the meeting's organizer, the
organizer must still be added to the invite recipient list explicitly, the
same way `_email_recipients` does for email — otherwise they silently get no
SharePoint view grant on a meeting they organized.

**Idempotency assumption:** both the file upload (`PUT .../content`, which
overwrites) and the `invite` action (granting a role a recipient already
has is a no-op, not an error) are believed safe to blindly re-run in full on
retry. This is what makes the atomic full-retry approach below sound rather
than merely convenient — if either call were to have ambiguous partial-effect
semantics on timeout (the way Graph's mail-send transport does, per IN-478),
atomic full-retry could double-invite or mis-order operations. This
assumption should be spot-checked against Graph's documented behavior during
implementation, not just assumed from the analogy to other delivery
channels.

## Error handling

Delivery is atomic: uploading a file and granting all of its recipients'
permissions is one unit of work. If any step fails — the upload itself, or
any individual `invite` call — the whole delivery is marked `failed` with a
safe, fixed error message, and a retry re-runs the entire sequence from
scratch (re-upload, then re-invite everyone). This reuses the existing
`SharePointStatus` enum (`not_started` / `saving` / `saved` / `failed`)
already on the Meeting model — no schema change is needed. It also matches
the failed-only-retry pattern established for Blob delivery (IN-386). Note
that email delivery (IN-94) is a related but not identical precedent: IN-478
added a distinct `unconfirmed` state specifically because Graph's mail-send
transport has ambiguous-on-timeout semantics, which plain failed-only-retry
cannot represent safely. This design's atomic full-retry is only correct if
the idempotency assumption above holds; if implementation finds otherwise,
follow IN-478's precedent (an intermediate/unconfirmed state) rather than
this one.

### Rejected alternative

**Split tracking** — treating upload and permission-granting as two
independently-tracked states (e.g. a file could be `saved` with permissions
separately `pending`/`failed`). Rejected: this needs a second status axis and
a partial-success UI state for a failure mode that should be rare, and it
breaks from every other delivery channel in this codebase, all of which use
a single failed-only-retry status.

## Configuration changes

- `sharepoint_drive_id` (`backend/app/config.py`): currently defaults to
  `""` (stub/local mode). Once the real Transcriptions drive ID is
  discovered (see "Open items"), it becomes the new default, following the
  same public-default pattern as `MN_STORAGE_API_URL`.
- `sharepoint_folder_path`: default changes from `"Notetaker Transcripts"`
  to `""` (library root). `GraphSharePointProvider` already treats an empty
  folder path as root-relative uploads
  (`test_graph_provider_uploads_to_library_root_when_folder_path_empty`), so
  this is a configuration-only change — no provider code changes needed for
  path handling.

## Testing

Unit tests (mocked Graph calls, extending `test_sharepoint_provider.py`):

- `invite` action payload shape: correct `roles`, `sendInvitation: false`,
  and recipient list construction.
- Atomic failure and retry: an injected failure at any step marks the whole
  delivery `failed`; a subsequent retry re-issues every call.
- Calendar vs. manual recipient source selection (`attendees` vs.
  `manual_attendees`).
- Calendar attendee list with some/all missing emails: recipients with
  `email is None` or blank are filtered out; remaining valid recipients are
  still invited; an all-missing list succeeds with owner-only access
  (mirrors the manual-attendee empty-list test, applied to the calendar
  source).
- Organizer inclusion: when the meeting organizer is not present in
  `attendees[]` (Graph's normal behavior) and differs from the recording
  owner, the organizer is still added to the invite recipient list.
- Empty-recipient-list edge case (manual recording with no
  `manual_attendees`) succeeds with owner-only access.

Live verification (manual, human-run — matches the existing IN-471/IN-381
"write-smoke" convention in this codebase, not automatable from here):

1. Sign in via the desktop app's existing MSAL flow.
2. Trigger a real SharePoint delivery for a test meeting.
3. Confirm the file appears in the real `Transcriptions` library at the
   library root with the expected filename.
4. Confirm a test invitee/attendee account has view-only access and no
   edit rights, and that the recording owner has full access.

## Open items requiring a human step

1. **Drive ID discovery.** Cannot be done from this session — requires an
   interactive Graph sign-in. Whoever picks up implementation should run the
   `GET /sites/.../drives` lookup described above and record the drive ID.
2. **Live write-access and permission smoke test**, per "Testing" above —
   requires a real signed-in session against the production tenant.
