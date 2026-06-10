import { Banknote, Calculator, ReceiptText, Users, type LucideIcon } from 'lucide-react'
import type { Tone } from '@renderer/components/ui/tones'
import type { Priority, Status } from '@renderer/components/ui/Pill'
import type {
  ActionItem,
  EnrollmentState,
  Meeting,
  StaffMember
} from '@renderer/data/mock'

// ---------------------------------------------------------------------------
// Wire shapes (backend/app/schemas.py). Keep in sync.
// ---------------------------------------------------------------------------

interface PersonEnrollmentDto {
  employee_id: string
  display_name: string
  role: string
  enrolled: boolean
  model_version: string | null
  reenrollment_required: boolean
}

export interface MeetingDto {
  id: string
  title: string
  context: string
  source: 'online' | 'in_person' | 'upload'
  owner_id: string
  status: 'draft' | 'finalized'
  created_at: string
  duration_seconds: number | null
  unknown_speaker_count: number
  action_item_count: number
}

export interface ActionItemDto {
  id: string
  meeting_id: string
  meeting_title: string
  owner: string | null
  description: string
  deadline: string | null
  priority: 'high' | 'medium' | 'low'
  status: 'open' | 'done'
}

export interface TranscriptSegmentDto {
  speaker: string
  speaker_known: boolean
  text: string
  start_ms: number
  end_ms: number
}

export interface MeetingReviewDto {
  meeting: MeetingDto
  summary_text: string | null
  participants: { name: string; known: boolean }[]
  segments: TranscriptSegmentDto[]
  action_items: ActionItemDto[]
}

const PREFIX = '/api/v1'

// ---------------------------------------------------------------------------
// Presentation mapping helpers
// ---------------------------------------------------------------------------

const TONES: Tone[] = ['info', 'success', 'warning', 'danger', 'secondary']
const MEETING_ICONS: LucideIcon[] = [ReceiptText, Users, Calculator, Banknote]

function hash(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(h)
}

/** Stable tone from a name so colours don't shuffle between renders. */
export function toneFor(name: string): Tone {
  return TONES[hash(name) % TONES.length]
}

function iconFor(title: string): LucideIcon {
  return MEETING_ICONS[hash(title) % MEETING_ICONS.length]
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function groupFor(iso: string): Meeting['group'] {
  const then = new Date(iso)
  const now = new Date()
  if (then.toDateString() === now.toDateString()) return 'Today'
  const weekAgo = new Date(now)
  weekAgo.setDate(now.getDate() - 6)
  return then >= weekAgo ? 'Earlier this week' : 'Older'
}

function capitalize<T extends string>(s: string): T {
  return (s.charAt(0).toUpperCase() + s.slice(1)) as T
}

function mapMeeting(dto: MeetingDto): Meeting {
  return {
    id: dto.id,
    title: dto.title,
    context: dto.context,
    date: dayLabel(dto.created_at),
    durationMin: Math.round((dto.duration_seconds ?? 0) / 60),
    actionItems: dto.action_item_count,
    status: dto.status === 'draft' ? 'Draft' : 'Finalized',
    unknownSpeakers: dto.unknown_speaker_count,
    icon: iconFor(dto.title),
    tone: toneFor(dto.title),
    attendees: [], // attendee avatars come with the Graph integration
    group: groupFor(dto.created_at)
  }
}

export function mapActionItem(dto: ActionItemDto): ActionItem {
  const today = new Date().toISOString().slice(0, 10)
  const overdue = dto.status === 'open' && dto.deadline !== null && dto.deadline < today
  const status: Status = dto.status === 'done' ? 'Done' : overdue ? 'Overdue' : 'Open'
  return {
    id: dto.id,
    description: dto.description,
    sourceMeeting: dto.meeting_title,
    meetingId: dto.meeting_id,
    owner: dto.owner,
    dueLabel: dto.deadline ? `due ${dayLabel(dto.deadline)}` : 'no deadline',
    dueISO: dto.deadline ?? '9999-12-31',
    overdue,
    priority: capitalize<Priority>(dto.priority),
    status
  }
}

// ---------------------------------------------------------------------------
// Fetchers — return null when the backend is unreachable so callers can fall
// back to sample data.
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** Null when outside Electron (browser preview) or the backend is unreachable. */
async function call<T>(method: Method, path: string, body?: unknown): Promise<T | null> {
  if (typeof window.api?.request !== 'function') return null
  const res = await window.api.request<T>(method, `${PREFIX}${path}`, body)
  return res.ok ? res.body : null
}

async function get<T>(path: string): Promise<T | null> {
  return call<T>('GET', path)
}

export async function fetchMeetings(): Promise<Meeting[] | null> {
  const body = await get<MeetingDto[]>('/meetings')
  return body ? body.map(mapMeeting) : null
}

export async function fetchActionItems(): Promise<ActionItem[] | null> {
  const body = await get<ActionItemDto[]>('/action-items')
  return body ? body.map(mapActionItem) : null
}

export async function fetchMeetingReview(meetingId: string): Promise<MeetingReviewDto | null> {
  return get<MeetingReviewDto>(`/meetings/${meetingId}/review`)
}

export async function nameSpeaker(
  meetingId: string,
  label: string,
  name: string
): Promise<MeetingReviewDto | null> {
  return call<MeetingReviewDto>('POST', `/meetings/${meetingId}/name-speaker`, { label, name })
}

export async function finalizeMeeting(meetingId: string): Promise<MeetingDto | null> {
  return call<MeetingDto>('POST', `/meetings/${meetingId}/finalize`)
}

function enrollmentState(dto: PersonEnrollmentDto): EnrollmentState {
  if (dto.reenrollment_required) return 'reenroll_required'
  return dto.enrolled ? 'enrolled' : 'not_enrolled'
}

export async function fetchPeople(): Promise<StaffMember[] | null> {
  const body = await get<PersonEnrollmentDto[]>('/people')
  if (!body) return null
  return body.map((dto) => ({
    id: dto.employee_id,
    name: dto.display_name,
    role: dto.role,
    tone: toneFor(dto.display_name),
    enrollment: enrollmentState(dto),
    modelVersion: dto.model_version
  }))
}
