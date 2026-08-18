# SharePoint Transcript Permission Hardening Design

**Date:** 18 August 2026  
**Jira:** IN-91, IN-398  
**Status:** Approved in conversation; implementation not started

## Goal

Prevent ordinary staff from reading or editing transcripts merely because
they can access the parent Transcriptions library. Future transcript and
summary files must be accessible only to:

- the recording owner, with write access;
- the meeting recipients selected by the existing recipient policy, with
  read access; and
- the existing Innovations and Systems management and IT administrators,
  without changing the parent library or its membership.

The application must break and verify permission inheritance before it
uploads either meeting artifact.

## Evidence and root cause

Live SharePoint inspection on 18 August 2026 showed the nested
`Transcriptions` folder, the Joseph and David owner folders, and two recent
transcript files granting:

- `Everyone except external users`: write;
- `Innovations and Systems Visitors`: read;
- `Innovations and Systems Members`: write; and
- `Innovations and Systems Owners`: owner.

David Ahlhaus independently checked a newly uploaded set of Jake's files on
18 August and confirmed that the group permissions were still present. His
13 August messages had already identified the same propagation from the
directory to folders and files.

The current Graph provider uploads a file and then calls
`POST /drives/{drive-id}/items/{item-id}/invite` for each meeting recipient.
It omits `retainInheritedPermissions`, whose documented default is `true`.
The direct read grants are therefore additive and do not restrict the broad
access inherited from the parent.

## Scope

### In scope

- Break inheritance on each staff owner's folder before uploading files.
- Keep the parent library and its permissions unchanged.
- Preserve the recording owner's write access explicitly.
- Preserve the existing management population's practical access using the
  existing Entra-backed management principal plus SharePoint site
  administrators. This does not create a new management group or change
  group membership.
- Verify that broad staff principals are absent before uploading content.
- Continue granting meeting recipients read access per file.
- Fail closed when privacy cannot be established.
- Add automated provider, route, proxy, retry, and failure tests.
- Perform a live multi-account smoke test before release.

### Out of scope

- Changing the parent Transcriptions library permissions.
- Creating a new SharePoint library.
- Changing who counts as a meeting recipient.
- Automatically repairing every historical transcript file. Existing files
  require a separate administrator-led remediation because some already
  have unique permission scopes.
- Sending new sharing-notification emails.

## Chosen design: secure the owner folder before upload

Uploads continue to target:

`Transcriptions/<owner display name>/<meeting artifact>`

For every delivery attempt, the provider resolves the owner folder to a
drive-item ID and runs a privacy preflight before writing content.

### 1. Resolve or create the owner folder

`GraphSharePointProvider` changes its existing owner-folder ensure operation
to return the folder's drive-item ID.

- A successful create parses the folder ID from the Graph response.
- A `409 nameAlreadyExists` response is followed by a path-based `GET` to
  resolve the existing folder ID.
- Failure to obtain an ID stops delivery.

### 2. Break inheritance while preserving the owner

The first permission operation on the folder is:

`POST /drives/{drive-id}/items/{folder-id}/invite`

with:

```json
{
  "recipients": [{ "email": "<recording-owner-email>" }],
  "requireSignIn": true,
  "sendInvitation": false,
  "roles": ["write"],
  "retainInheritedPermissions": false
}
```

Microsoft Graph documents that `false` removes existing inherited
permissions the first time the item is shared. The recording owner is the
recipient of that same operation so the folder never intentionally enters a
state with no working owner.

The main process must inject the existing signed-in email as
`X-MN-User-Email` on the SharePoint delivery request. The backend rejects a
configured/live SharePoint delivery without a usable owner email; display
name is still used only for the folder name.

### 3. Preserve existing management access

After the owner grant succeeds, the provider silently grants `write` to the
existing Entra group `SP - Innovations and Systems` using a Graph
`driveRecipient.objectId`. Live SharePoint inspection identified its Entra
object ID as `b25cba77-70a4-45e3-96d6-b6146ecbeed0`. The object ID is tenant
configuration, not renderer data, and is supplied through an
`MN_SHAREPOINT_MANAGEMENT_GROUP_ID` setting. SharePoint site collection
administrators continue to retain their administrative access independently.

This step preserves the same management population and does not change the
parent library, create a replacement group, or alter group membership.

If the management grant fails, delivery stops before either artifact is
uploaded. A retry can safely repeat the owner and management grants.

### 4. Verify the effective folder ACL

Before uploading content, the provider calls:

`GET /drives/{drive-id}/items/{folder-id}/permissions`

The preflight succeeds only when:

- the recording owner has write access;
- the configured management group has write access; and
- none of the known broad principals is present:
  - `Everyone except external users`;
  - `Innovations and Systems Visitors`; or
  - `Innovations and Systems Members`.

Microsoft Graph does not reliably populate `inheritedFrom` for permissions
in SharePoint document libraries. Verification therefore uses the effective
principal identities returned by the permission listing rather than trusting
that property.

If a previously shared owner folder ignores
`retainInheritedPermissions: false`, the broad principals remain visible and
the preflight fails. No transcript or summary is uploaded into that folder;
an administrator must repair that folder once before deliveries resume.

### 5. Upload the two artifacts

Only after the privacy preflight succeeds does the existing delivery loop
upload:

- `[YYYY-MM-DD] [Meeting Title] - Transcript.md`; and
- `[YYYY-MM-DD] [Meeting Title] - Summary.md`.

New files inherit only the secured owner-folder permissions. The existing
both-files delivery status and deterministic retry names remain unchanged.

### 6. Grant per-meeting read access

After each upload, the current per-recipient Graph invitations continue with:

- `roles: ["read"]`;
- `requireSignIn: true`;
- `sendInvitation: false`; and
- the existing allowed-company-domain policy.

These direct file grants add meeting-specific viewers while retaining the
restricted owner and management access inherited from the secured owner
folder. An ungrantable meeting recipient continues to produce the existing
warning rather than exposing the file more broadly.

## Failure and retry behaviour

Permission hardening is a mandatory precondition, not a warning.

- Folder resolution failure: mark SharePoint delivery failed; upload nothing.
- Missing owner email: mark SharePoint delivery failed; upload nothing.
- Inheritance break failure: mark SharePoint delivery failed; upload nothing.
- Management grant failure: mark SharePoint delivery failed; upload nothing.
- Permission verification failure: mark SharePoint delivery failed; upload
  nothing and log the unexpected principal names without exposing transcript
  content.
- File upload failure: retain the existing failed/retry behaviour.
- Meeting-recipient grant failure: save successfully with the existing
  ungranted-recipient warning, because the file remains private to owner and
  management.

Retries rerun the privacy preflight before any upload. A folder that is
already correctly secured passes verification idempotently.

## Components changed during implementation

- `src/main/api-proxy.ts`
  - inject `X-MN-User-Email` for SharePoint POST requests.
- `backend/app/config.py` and environment templates
  - add the management-group object-ID setting.
- `backend/app/routers/meetings.py`
  - accept and validate the owner email;
  - pass it into the provider privacy preflight;
  - keep the existing audit and delivery-state transitions.
- `backend/app/services/sharepoint.py`
  - return owner-folder metadata;
  - break inheritance;
  - grant the existing management group;
  - list and verify effective permissions;
  - upload only after successful verification.
- Existing SharePoint tests and request-policy verification scripts
  - cover the new header and fail-closed call ordering.

## Test design

Automated tests must prove:

1. Owner email is injected by Electron main and never supplied by the
   renderer.
2. Folder create and existing-folder resolution both return an item ID.
3. The first owner invitation contains
   `retainInheritedPermissions: false` exactly.
4. The owner receives write, the existing management group receives write,
   and meeting recipients receive read.
5. Permission verification occurs before the first content `PUT`.
6. Broad staff principals cause a hard failure and zero content uploads.
7. Missing owner email or management configuration fails closed in live
   SharePoint mode while local stub mode still works.
8. A secured existing folder is idempotent across retries.
9. Transcript and summary retain their current deterministic names and
   both-or-nothing status handling.
10. Recipient grant failures retain the current warning behaviour without
    weakening folder permissions.

## Live verification and release gate

Use a disposable test meeting and at least three accounts:

- recording owner;
- invited internal attendee; and
- ordinary internal non-attendee.

The release is blocked until all of these checks pass:

1. Trigger delivery from the recording owner's installed desktop app.
2. Inspect the owner folder and both files in SharePoint Manage Access.
3. Confirm the broad staff groups are absent from the owner folder.
4. Confirm the owner can open and edit both files.
5. Confirm the invited attendee can open but cannot edit both files.
6. Confirm the ordinary non-attendee cannot discover or open either file,
   even with the direct URL.
7. Confirm an Innovations and Systems manager or IT administrator can still
   manage the folder and files.
8. Retry delivery and confirm the ACL remains restricted and no duplicate
   files are created.

After the new path passes, administrators can remediate historical files as
a separate controlled operation. No code or release claim may treat the
future-upload fix as proof that historical permissions were repaired.

## Alternatives considered

### Break inheritance on every file after upload

This is the smallest code change: upload a file, then use the first invite
with `retainInheritedPermissions: false`. It was rejected because every file
is broadly accessible between upload and permission hardening, and a failed
hardening request can leave sensitive content behind with inherited access.

### Lock the library and upload through a central service identity

This gives the strongest default isolation because ordinary staff would not
need parent-library write access. It was rejected for this correction because
it changes the existing delegated-upload architecture, parent-library access,
deployment model, and operational ownership. It is a possible future
hardening project, not the smallest safe fix for IN-91/IN-398.

### Secure each owner folder before upload — selected

This keeps the current delegated upload path and parent library intact while
ensuring that no new transcript content is written until the destination has
been made private and verified.

## Reference links

- Jira IN-91: <https://factor1.atlassian.net/browse/IN-91>
- Jira IN-398: <https://factor1.atlassian.net/browse/IN-398>
- SharePoint Transcriptions library:
  <https://futurebusinessgroup.sharepoint.com/sites/InnovationsandSystems/Transcriptions/Forms/AllItems.aspx>
- Microsoft Graph `driveItem: invite`:
  <https://learn.microsoft.com/en-us/graph/api/driveitem-invite?view=graph-rest-1.0>
- Microsoft Graph `driveRecipient`:
  <https://learn.microsoft.com/en-us/graph/api/resources/driverecipient?view=graph-rest-1.0>
- Microsoft Graph list drive-item permissions:
  <https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0>
