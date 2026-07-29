import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { isStorageRoute } from '../src/main/api-request-policy'
import { hasStorageAdminRole } from '../src/main/storage-api-identity'
import { SettingsScreen } from '../src/renderer/src/screens/SettingsScreen'
import {
  VoiceprintAdminView,
  VoiceprintConfirmation
} from '../src/renderer/src/screens/VoiceprintAdminScreen'
import type {
  VoiceprintAdminRecord,
  VoiceprintAuditEvent
} from '../src/renderer/src/lib/api'

const originalConsoleError = console.error
console.error = (...args: unknown[]): void => {
  if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return
  originalConsoleError(...args)
}

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

assert.equal(
  hasStorageAdminRole(token({ roles: ['StorageApi.Admin'] })),
  true,
  'the exact Storage API administrator role exposes the management UI'
)
assert.equal(
  hasStorageAdminRole(token({ roles: ['StorageApi.Reader'] })),
  false,
  'other roles do not expose administrator controls'
)
assert.equal(hasStorageAdminRole('not-a-jwt'), false, 'malformed tokens fail closed')

for (const request of [
  { method: 'GET' as const, path: '/api/v1/voiceprint-admin' },
  { method: 'GET' as const, path: '/api/v1/voiceprint-admin/audit-events' },
  { method: 'POST' as const, path: '/api/v1/voiceprint-admin/oid-1/disable' },
  { method: 'POST' as const, path: '/api/v1/voiceprint-admin/oid-1/enable' },
  { method: 'DELETE' as const, path: '/api/v1/voiceprint-admin/oid-1' }
]) {
  assert.equal(isStorageRoute(request), true, `${request.method} ${request.path} receives a token`)
}

const settingsProps = {
  previewMode: true,
  theme: 'system' as const,
  onSetTheme: () => undefined,
  userName: 'Admin User',
  userEmail: 'admin@example.com',
  onOpenVoiceprintAdmin: () => undefined,
  onSignOut: () => undefined,
  onClose: () => undefined
}
const adminSettings = renderToStaticMarkup(
  <SettingsScreen {...settingsProps} isStorageAdmin />
)
assert.match(adminSettings, /Voiceprint management/, 'admin settings expose management')
const staffSettings = renderToStaticMarkup(
  <SettingsScreen {...settingsProps} isStorageAdmin={false} />
)
assert.doesNotMatch(
  staffSettings,
  /Voiceprint management/,
  'non-admin settings hide management'
)

const baseRecord: VoiceprintAdminRecord = {
  person_id: 'oid-active',
  email: 'alex@example.com',
  display_name: 'Alex Active',
  status: 'active',
  sample_sources: ['recorded'],
  consent_recorded_at: '2026-07-01T02:00:00Z',
  created_at: '2026-07-01T02:00:00Z',
  updated_at: '2026-07-28T02:00:00Z',
  disabled_at: null,
  deleted_at: null,
  last_used_at: '2026-07-28T02:00:00Z',
  voiceprint_count: 3
}
const records: VoiceprintAdminRecord[] = [
  baseRecord,
  {
    ...baseRecord,
    person_id: 'oid-disabled',
    display_name: 'Drew Disabled',
    email: 'drew@example.com',
    status: 'disabled',
    disabled_at: '2026-07-29T01:00:00Z'
  },
  {
    ...baseRecord,
    person_id: 'oid-deleted',
    display_name: 'Terry Tombstone',
    email: 'terry@example.com',
    status: 'deleted',
    voiceprint_count: 0,
    deleted_at: '2026-07-29T02:00:00Z'
  }
]
const auditEvents: VoiceprintAuditEvent[] = [
  {
    schema_version: 1,
    event_id: 'event-1',
    occurred_at: '2026-07-29T02:00:00Z',
    actor_oid: 'admin-oid',
    actor_name: 'Admin User',
    action: 'voiceprint_deleted',
    target: 'oid-deleted',
    correlation_id: 'correlation-1',
    details: { status: 'deleted' }
  }
]
const view = renderToStaticMarkup(
  <VoiceprintAdminView
    records={records}
    auditEvents={auditEvents}
    loading={false}
    error={null}
    notice={null}
    busyOid={null}
    onBack={() => undefined}
    onClose={() => undefined}
    onRefresh={() => undefined}
    onRequestAction={() => undefined}
  />
)
assert.match(view, /All statuses/, 'the required SelectMenu status filter is present')
assert.match(view, /Alex Active/, 'active voiceprints are listed')
assert.match(view, /Drew Disabled/, 'disabled voiceprints are listed')
assert.match(view, /Terry Tombstone/, 'deleted tombstones are listed')
assert.match(view, /Last used/, 'last-used metadata is shown')
assert.match(view, /Consent recorded/, 'consent metadata is shown')
assert.match(view, /Disable/, 'active records can be disabled')
assert.match(view, /Re-enable/, 'disabled records can be re-enabled')
assert.match(view, /Delete permanently/, 'destructive delete is available')
assert.match(view, /Audit log/, 'the immutable audit view is present')
assert.match(view, /Voiceprint deleted/, 'audit actions are rendered read-only')

const disableConfirmation = renderToStaticMarkup(
  <VoiceprintConfirmation
    action="disable"
    record={baseRecord}
    busy={false}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />
)
assert.match(disableConfirmation, /role="alertdialog"/, 'disable requires an alert dialog')
assert.match(
  disableConfirmation,
  /no longer be included in speaker identification/,
  'disable impact is explicit'
)

const deleteConfirmation = renderToStaticMarkup(
  <VoiceprintConfirmation
    action="delete"
    record={baseRecord}
    busy={false}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />
)
assert.match(deleteConfirmation, /This cannot be undone/, 'delete irreversibility is explicit')
assert.match(deleteConfirmation, /metadata tombstone/, 'delete retention is explicit')

console.error = originalConsoleError
console.log('Voiceprint admin verification passed.')
