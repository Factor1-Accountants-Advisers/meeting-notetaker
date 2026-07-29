import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  UserRoundX,
  X
} from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { SelectMenu, type SelectOption } from '@renderer/components/ui/SelectMenu'
import {
  deleteVoiceprint,
  disableVoiceprint,
  enableVoiceprint,
  fetchVoiceprintAdminRecords,
  fetchVoiceprintAuditEvents,
  type VoiceprintAdminRecord,
  type VoiceprintAdminStatus,
  type VoiceprintAuditEvent
} from '@renderer/lib/api'

type LifecycleAction = 'disable' | 'enable' | 'delete'
type StatusFilter = 'all' | VoiceprintAdminStatus

interface Props {
  onBack: () => void
  onClose: () => void
}

const STATUS_OPTIONS: SelectOption<StatusFilter>[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'deleted', label: 'Deleted' }
]

export function VoiceprintAdminScreen({ onBack, onClose }: Props): JSX.Element {
  const [records, setRecords] = useState<VoiceprintAdminRecord[]>([])
  const [auditEvents, setAuditEvents] = useState<VoiceprintAuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyOid, setBusyOid] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    action: 'disable' | 'delete'
    record: VoiceprintAdminRecord
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextRecords, nextEvents] = await Promise.all([
        fetchVoiceprintAdminRecords(),
        fetchVoiceprintAuditEvents()
      ])
      setRecords(nextRecords)
      setAuditEvents(nextEvents)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Voiceprint administration is temporarily unavailable.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const applyAction = async (
    action: LifecycleAction,
    record: VoiceprintAdminRecord
  ): Promise<void> => {
    setBusyOid(record.person_id)
    setError(null)
    setNotice(null)
    try {
      const response =
        action === 'disable'
          ? await disableVoiceprint(record.person_id)
          : action === 'enable'
            ? await enableVoiceprint(record.person_id)
            : await deleteVoiceprint(record.person_id)
      setRecords((current) =>
        current.map((item) =>
          item.person_id === response.record.person_id ? response.record : item
        )
      )
      setNotice(
        `${response.record.display_name} is now ${response.record.status}. Audit event ${response.audit_event_id}.`
      )
      setAuditEvents(await fetchVoiceprintAuditEvents())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The administrator action failed.')
    } finally {
      setConfirmation(null)
      setBusyOid(null)
    }
  }

  return (
    <>
      <VoiceprintAdminView
        records={records}
        auditEvents={auditEvents}
        loading={loading}
        error={error}
        notice={notice}
        busyOid={busyOid}
        onBack={onBack}
        onClose={onClose}
        onRefresh={() => void load()}
        onRequestAction={(action, record) => {
          if (action === 'enable') {
            void applyAction(action, record)
          } else {
            setConfirmation({ action, record })
          }
        }}
      />
      {confirmation &&
        createPortal(
          <VoiceprintConfirmation
            action={confirmation.action}
            record={confirmation.record}
            busy={busyOid === confirmation.record.person_id}
            onCancel={() => setConfirmation(null)}
            onConfirm={() => void applyAction(confirmation.action, confirmation.record)}
          />,
          document.body
        )}
    </>
  )
}

export function VoiceprintAdminView({
  records,
  auditEvents,
  loading,
  error,
  notice,
  busyOid,
  onBack,
  onClose,
  onRefresh,
  onRequestAction
}: {
  records: VoiceprintAdminRecord[]
  auditEvents: VoiceprintAuditEvent[]
  loading: boolean
  error: string | null
  notice: string | null
  busyOid: string | null
  onBack: () => void
  onClose: () => void
  onRefresh: () => void
  onRequestAction: (action: LifecycleAction, record: VoiceprintAdminRecord) => void
}): JSX.Element {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const visibleRecords = useMemo(
    () =>
      statusFilter === 'all'
        ? records
        : records.filter((record) => record.status === statusFilter),
    [records, statusFilter]
  )

  return (
    <div className="ui-enter flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="ui-control mb-0.5 flex items-center gap-1.5 rounded-md py-1 pr-2 text-[14px] text-content-secondary hover:text-content-primary"
          >
            <ArrowLeft size={15} />
            Settings
          </button>
          <h2 className="m-0 text-[20px] font-medium text-content-primary">
            Voiceprint management
          </h2>
          <p className="mb-0 mt-1 text-[12px] text-content-tertiary">
            Central enrolments and immutable administrator activity
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ui-control flex min-h-7 items-center gap-1.5 rounded-control px-2 text-[14px] text-content-secondary hover:bg-bg-secondary hover:text-content-primary"
        >
          <X size={15} />
          Close
        </button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <SelectMenu
          ariaLabel="Voiceprint status"
          value={statusFilter}
          options={STATUS_OPTIONS}
          onChange={setStatusFilter}
          className="w-[176px]"
        />
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="ui-control flex min-h-8 items-center gap-1.5 rounded-control border border-edge-secondary px-2.5 text-[13px] text-content-primary hover:bg-bg-secondary disabled:opacity-45"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-edge-danger bg-bg-danger px-3 py-2 text-[12px] text-content-danger"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-edge-info bg-bg-info px-3 py-2 text-[12px] text-content-info"
        >
          <CheckCircle2 size={14} className="mt-px shrink-0" />
          {notice}
        </div>
      )}

      <section aria-labelledby="voiceprints-heading">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="voiceprints-heading" className="m-0 text-[18px] font-medium text-content-primary">
            Registered voiceprints
          </h3>
          <span className="text-[12px] text-content-tertiary">
            {visibleRecords.length} of {records.length}
          </span>
        </div>
        {loading && records.length === 0 ? (
          <LoadingRow label="Loading central voiceprints…" />
        ) : visibleRecords.length === 0 ? (
          <Card className="px-3 py-4 text-center text-[13px] text-content-tertiary">
            No voiceprints match this status.
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleRecords.map((record) => (
              <VoiceprintRecordCard
                key={record.person_id}
                record={record}
                busy={busyOid === record.person_id}
                onAction={(action) => onRequestAction(action, record)}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="audit-heading">
        <h3 id="audit-heading" className="mb-2 mt-0 text-[18px] font-medium text-content-primary">
          Audit log
        </h3>
        <Card>
          {loading && auditEvents.length === 0 ? (
            <LoadingRow label="Loading administrator activity…" />
          ) : auditEvents.length === 0 ? (
            <div className="px-3 py-4 text-center text-[13px] text-content-tertiary">
              No voiceprint activity in the last 31 days.
            </div>
          ) : (
            auditEvents.map((event) => (
              <div
                key={event.event_id}
                className="grid grid-cols-[1fr_auto] gap-3 border-t border-edge-tertiary px-3 py-2.5 first:border-t-0 max-[480px]:grid-cols-1"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-content-primary">
                    {auditActionLabel(event.action)}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-content-tertiary">
                    {event.actor_name} · {event.target}
                  </div>
                </div>
                <time
                  dateTime={event.occurred_at}
                  className="text-[12px] text-content-tertiary"
                >
                  {formatDate(event.occurred_at)}
                </time>
              </div>
            ))
          )}
        </Card>
      </section>
    </div>
  )
}

function VoiceprintRecordCard({
  record,
  busy,
  onAction
}: {
  record: VoiceprintAdminRecord
  busy: boolean
  onAction: (action: LifecycleAction) => void
}): JSX.Element {
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-content-primary">
            {record.display_name}
          </div>
          <div className="truncate text-[12px] text-content-tertiary">
            {record.email ?? 'No email recorded'}
          </div>
        </div>
        <StatusBadge status={record.status} />
      </div>
      <dl className="mb-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] max-[440px]:grid-cols-1">
        <Metadata label="Sample source" value={sampleSourceLabel(record.sample_sources)} />
        <Metadata label="Consent recorded" value={formatDate(record.consent_recorded_at)} />
        <Metadata label="Last used" value={formatDate(record.last_used_at)} />
        <Metadata
          label="Voiceprints"
          value={record.status === 'deleted' ? 'Artifacts deleted' : String(record.voiceprint_count)}
        />
      </dl>
      {record.status !== 'deleted' && (
        <div className="mt-3 flex justify-end gap-2 border-t border-edge-tertiary pt-2.5">
          {record.status === 'active' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('disable')}
              className="ui-control flex min-h-8 items-center gap-1.5 rounded-control border border-edge-secondary px-2.5 text-[13px] text-content-primary hover:bg-bg-secondary disabled:opacity-45"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <UserRoundX size={14} />}
              Disable
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('enable')}
              className="ui-control flex min-h-8 items-center gap-1.5 rounded-control border border-edge-info bg-bg-info px-2.5 text-[13px] text-content-info hover:opacity-90 disabled:opacity-45"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <UserRoundCheck size={14} />}
              Re-enable
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction('delete')}
            className="ui-control flex min-h-8 items-center gap-1.5 rounded-control border border-edge-danger px-2.5 text-[13px] text-content-danger hover:bg-bg-danger disabled:opacity-45"
          >
            <Trash2 size={14} />
            Delete permanently
          </button>
        </div>
      )}
    </Card>
  )
}

export function VoiceprintConfirmation({
  action,
  record,
  busy,
  onCancel,
  onConfirm
}: {
  action: 'disable' | 'delete'
  record: VoiceprintAdminRecord
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const deleting = action === 'delete'
  return (
    <div
      className="ui-backdrop fixed inset-0 z-[80] flex items-center justify-center bg-[var(--color-background-modal)] p-4"
      role="presentation"
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="voiceprint-confirm-title"
        aria-describedby="voiceprint-confirm-description"
        className="ui-enter w-full max-w-[400px] rounded-card bg-bg-primary p-4"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-danger text-content-danger">
            {deleting ? <Trash2 size={16} /> : <ShieldCheck size={16} />}
          </span>
          <div>
            <h2
              id="voiceprint-confirm-title"
              className="m-0 text-[18px] font-medium text-content-primary"
            >
              {deleting ? 'Permanently delete voiceprint?' : 'Disable voiceprint?'}
            </h2>
            <p
              id="voiceprint-confirm-description"
              className="mb-0 mt-1.5 text-[13px] leading-relaxed text-content-secondary"
            >
              {deleting
                ? `${record.display_name}'s voiceprint artifacts will be permanently removed. A deleted metadata tombstone and audit event will be retained. This cannot be undone.`
                : `${record.display_name} will no longer be included in speaker identification until an administrator re-enables the voiceprint.`}
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="ui-control min-h-8 rounded-control border border-edge-secondary px-3 text-[13px] text-content-primary hover:bg-bg-secondary disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="ui-control flex min-h-8 items-center gap-1.5 rounded-control border border-edge-danger bg-bg-danger px-3 text-[13px] text-content-danger hover:opacity-90 disabled:opacity-45"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {deleting ? 'Delete permanently' : 'Disable voiceprint'}
          </button>
        </div>
      </section>
    </div>
  )
}

function Metadata({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-content-tertiary">{label}</dt>
      <dd className="m-0 mt-0.5 text-content-secondary">{value}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: VoiceprintAdminStatus }): JSX.Element {
  const className =
    status === 'active'
      ? 'bg-bg-info text-content-info'
      : status === 'disabled'
        ? 'bg-bg-warning text-content-warning'
        : 'bg-bg-danger text-content-danger'
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function LoadingRow({ label }: { label: string }): JSX.Element {
  return (
    <Card className="flex items-center justify-center gap-2 px-3 py-4 text-[13px] text-content-tertiary">
      <Loader2 size={15} className="animate-spin" />
      {label}
    </Card>
  )
}

function formatDate(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function sampleSourceLabel(sources: VoiceprintAdminRecord['sample_sources']): string {
  const unique = [...new Set(sources)]
  if (unique.length === 0) return 'Unknown'
  return unique.map((source) => (source === 'recorded' ? 'Recorded' : 'Uploaded')).join(', ')
}

function auditActionLabel(action: string): string {
  return action
    .replace(/^voiceprint_/, 'Voiceprint ')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}
