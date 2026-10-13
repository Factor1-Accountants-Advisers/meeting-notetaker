import { findPromptedCallMeetingId } from './promptedCallRecovery'

export interface PendingCallEnd {
  nonce: string
  endedAtUtc: string
}

interface OutboxStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface CallEndAcknowledgement {
  graph_metadata?: { prompted_call?: { nonce?: string; observed_end_utc?: string | null } | null } | null
}

interface StoredCallMeeting {
  id: string
  source: string
  graph_metadata?: { prompted_call?: { nonce?: string } | null } | null
}

function outboxKey(account: string): string | null {
  const owner = account.trim().toLowerCase()
  return owner ? 'mn.prompted-call-ends.v1.' + encodeURIComponent(owner) : null
}

function validEnd(value: unknown): value is PendingCallEnd {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PendingCallEnd>
  return typeof item.nonce === 'string' && item.nonce.trim().length > 0 &&
    item.nonce.length <= 256 && typeof item.endedAtUtc === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(item.endedAtUtc) && Number.isFinite(Date.parse(item.endedAtUtc))
}

/** A local wake-up queue, not an authority for participants or ownership. */
export function loadCallEndOutbox(storage: OutboxStorage, account: string): PendingCallEnd[] {
  const key = outboxKey(account)
  if (!key) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const entries = new Map<string, PendingCallEnd>()
    for (const item of parsed) {
      if (validEnd(item) && !entries.has(item.nonce)) {
        entries.set(item.nonce, { nonce: item.nonce, endedAtUtc: item.endedAtUtc })
      }
    }
    return [...entries.values()]
  } catch {
    return []
  }
}

/** Queue before attempting HTTP; never replace the first end for a nonce. */
export function queueCallEnd(storage: OutboxStorage, account: string, end: PendingCallEnd): boolean {
  const key = outboxKey(account)
  if (!key || !validEnd(end)) return false
  try {
    const entries = loadCallEndOutbox(storage, account)
    if (!entries.some((entry) => entry.nonce === end.nonce)) {
      entries.push({ nonce: end.nonce, endedAtUtc: end.endedAtUtc })
    }
    storage.setItem(key, JSON.stringify(entries))
    return true
  } catch {
    return false
  }
}

/** Only a read-back of the same durable nonce/end can clear the queue. */
export function acknowledgeCallEnd(
  storage: OutboxStorage,
  account: string,
  end: PendingCallEnd,
  meeting: CallEndAcknowledgement | null
): boolean {
  const key = outboxKey(account)
  const marker = meeting?.graph_metadata?.prompted_call
  if (!key || !validEnd(end) || marker?.nonce !== end.nonce || !marker.observed_end_utc ||
      Date.parse(marker.observed_end_utc) !== Date.parse(end.endedAtUtc)) return false
  try {
    const entries = loadCallEndOutbox(storage, account)
    const pending = entries.find((entry) => entry.nonce === end.nonce)
    if (!pending || Date.parse(pending.endedAtUtc) !== Date.parse(end.endedAtUtc)) return false
    storage.setItem(key, JSON.stringify(entries.filter((entry) => entry.nonce !== end.nonce)))
    return true
  } catch {
    return false
  }
}

/** Called on sign-in and periodic recovery; a cancelled account never replays. */
export async function replayCallEndOutbox(options: {
  storage: OutboxStorage
  account: string
  isCurrent(): boolean
  fetchMeetings(): Promise<readonly StoredCallMeeting[] | null>
  recordEnded(meetingId: string, endedAtUtc: string): Promise<CallEndAcknowledgement | null>
}): Promise<void> {
  if (!options.isCurrent()) return
  const pending = loadCallEndOutbox(options.storage, options.account)
  if (!pending.length) return
  let meetings: readonly StoredCallMeeting[] | null
  try { meetings = await options.fetchMeetings() } catch { return }
  if (!options.isCurrent() || !meetings) return
  for (const end of pending) {
    if (!options.isCurrent()) return
    const id = findPromptedCallMeetingId(meetings, end.nonce)
    if (!id) continue
    try {
      const stored = await options.recordEnded(id, end.endedAtUtc)
      if (!options.isCurrent()) return
      acknowledgeCallEnd(options.storage, options.account, end, stored)
    } catch {
      // Offline/denied requests retain the original event for a later retry.
    }
  }
}
