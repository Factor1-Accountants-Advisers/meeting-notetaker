import { Banknote, Calculator, ReceiptText, Users, type LucideIcon } from 'lucide-react'
import type { Tone } from '@renderer/components/ui/tones'
import type { Priority, Status } from '@renderer/components/ui/Pill'
import type {
  ActionItem,
  DeliveryStatus,
  EnrollmentState,
  Meeting,
  PipelineStage,
  PipelineStatus,
  SharePointStatus,
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
  pipeline_status: PipelineStatus
  pipeline_stage: PipelineStage
  pipeline_stage_message: string
  delivery_status: DeliveryStatus
  delivery_error_message: string | null
  sharepoint_status: SharePointStatus
  sharepoint_error_message: string | null
  sharepoint_web_url: string | null
  graph_metadata?: GraphMeetingMetadataDto | null
}

export interface GraphMeetingMetadata {
  title?: string
  attendees: { name?: string; email?: string; response?: string }[]
  meetingId: string
  onlineMeetingId?: string
  joinWebUrl?: string
  organizerEmail?: string
}

export interface GraphMeetingMetadataDto {
  title?: string
  attendees: { name?: string; email?: string; response?: string }[]
  meeting_id: string
  online_meeting_id?: string | null
  join_web_url?: string | null
  organizer_email?: string | null
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
  raw_speaker?: string | null
  speaker_source?: string
  speaker_confidence?: number | null
  speaker_evidence_start_ms?: number | null
  speaker_evidence_end_ms?: number | null
  speaker_evidence_job_id?: string | null
  unknown_reason?: string | null
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
    group: groupFor(dto.created_at),
    pipelineStatus: dto.pipeline_status,
    pipelineStage: dto.pipeline_stage,
    pipelineStageMessage: dto.pipeline_stage_message,
    deliveryStatus: dto.delivery_status,
    deliveryErrorMessage: dto.delivery_error_message,
    sharePointStatus: dto.sharepoint_status,
    sharePointErrorMessage: dto.sharepoint_error_message,
    sharePointWebUrl: dto.sharepoint_web_url,
    source: dto.source
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

function errorMessage(body: unknown): string {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
  }
  return 'Request failed'
}

async function callRequired<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (typeof window.api?.request !== 'function') throw new Error('Backend bridge is unavailable')
  const res = await window.api.request<T>(method, `${PREFIX}${path}`, body)
  if (res.ok && res.body !== null) return res.body as T
  if (res.ok) throw new Error('Backend returned an empty response')
  throw new Error(errorMessage(res.body))
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

export async function createMeeting(
  title: string,
  meetingLink: string | null,
  source?: 'online' | 'in_person' | 'upload',
  graphMetadata?: GraphMeetingMetadata | null
): Promise<MeetingDto | null> {
  // Link present implies an online meeting (loopback + mic); otherwise in-person.
  // The link itself is only used for Graph title/attendee auto-fill later.
  return call<MeetingDto>('POST', '/meetings', {
    title,
    source: source ?? (meetingLink ? 'online' : 'in_person'),
    meeting_link: meetingLink,
    graph_metadata: graphMetadata ? toGraphMetadataDto(graphMetadata) : null
  })
}

/** One system-audio capture segment; offsetMs places it on the merge timeline (IN-468). */
export interface SystemAudioSegmentUpload {
  audioB64: string
  mimeType: string
  offsetMs: number
}

export async function uploadAudio(
  meetingId: string,
  audioB64: string,
  mimeType: string,
  durationSeconds: number | null,
  graphMetadata?: GraphMeetingMetadata | null,
  systemSegments?: SystemAudioSegmentUpload[] | null
): Promise<MeetingDto | null> {
  return call<MeetingDto>('POST', `/meetings/${meetingId}/audio`, {
    audio_b64: audioB64,
    mime_type: mimeType,
    duration_seconds: durationSeconds,
    graph_metadata: graphMetadata ? toGraphMetadataDto(graphMetadata) : null,
    system_segments: systemSegments?.length
      ? systemSegments.map((segment) => ({
          audio_b64: segment.audioB64,
          mime_type: segment.mimeType,
          offset_ms: segment.offsetMs
        }))
      : null
  })
}

function toGraphMetadataDto(metadata: GraphMeetingMetadata): GraphMeetingMetadataDto {
  return {
    title: metadata.title,
    attendees: metadata.attendees,
    meeting_id: metadata.meetingId,
    online_meeting_id: metadata.onlineMeetingId ?? null,
    join_web_url: metadata.joinWebUrl ?? null,
    organizer_email: metadata.organizerEmail ?? null
  }
}

export async function retryPipeline(meetingId: string): Promise<MeetingDto | null> {
  return call<MeetingDto>('POST', `/meetings/${meetingId}/retry`)
}

export async function editSegment(
  meetingId: string,
  index: number,
  text: string
): Promise<MeetingReviewDto | null> {
  return call<MeetingReviewDto>('PATCH', `/meetings/${meetingId}/segments/${index}`, { text })
}

export async function patchActionItem(
  itemId: string,
  changes: { owner?: string | null; status?: 'open' | 'done' }
): Promise<ActionItemDto | null> {
  return call<ActionItemDto>('PATCH', `/action-items/${itemId}`, changes)
}

export interface EmailResultDto {
  recipients: string[]
  sent_at: string
}

export async function emailNotes(
  meetingId: string,
  note: string | null,
  recorderEmail?: string | null
): Promise<EmailResultDto | null> {
  return call<EmailResultDto>('POST', `/meetings/${meetingId}/email`, {
    note,
    recorder_email: recorderEmail ?? null
  })
}

export async function saveTranscriptToSharePoint(meetingId: string): Promise<MeetingDto | null> {
  return call<MeetingDto>('POST', `/meetings/${meetingId}/sharepoint`)
}

export interface AuditEntryDto {
  id: string
  meeting_id: string | null
  actor: string
  action: string
  target: string
  before: string | null
  after: string | null
  at: string
}

export async function fetchAudit(meetingId: string): Promise<AuditEntryDto[] | null> {
  return get<AuditEntryDto[]>(`/meetings/${meetingId}/audit`)
}

/** Direct media URL for the stored meeting audio (dev backend). */
export function audioUrl(meetingId: string): string {
  return `http://127.0.0.1:8787${PREFIX}/meetings/${meetingId}/audio`
}

export interface AccessEntryDto {
  user: string
  role: 'owner' | 'editor' | 'viewer'
}

export async function fetchAccess(meetingId: string): Promise<AccessEntryDto[] | null> {
  return get<AccessEntryDto[]>(`/meetings/${meetingId}/access`)
}

export async function grantAccess(
  meetingId: string,
  user: string,
  role: 'editor' | 'viewer'
): Promise<AccessEntryDto[] | null> {
  return call<AccessEntryDto[]>('POST', `/meetings/${meetingId}/access`, { user, role })
}

export async function revokeAccess(
  meetingId: string,
  user: string
): Promise<AccessEntryDto[] | null> {
  return call<AccessEntryDto[]>('DELETE', `/meetings/${meetingId}/access/${encodeURIComponent(user)}`)
}

export interface SearchResultDto {
  meeting_id: string
  meeting_title: string
  kind: 'meeting' | 'summary' | 'transcript' | 'action_item'
  snippet: string
}

export async function searchAll(q: string): Promise<SearchResultDto[] | null> {
  return get<SearchResultDto[]>(`/search?q=${encodeURIComponent(q)}`)
}

export async function ensureCurrentPerson(name: string, email: string): Promise<StaffMember | null> {
  const dto = await call<PersonEnrollmentDto>('POST', '/people/me', { name, email })
  if (!dto) return null
  return {
    id: dto.employee_id,
    name: dto.display_name,
    role: dto.role,
    tone: toneFor(dto.display_name),
    enrollment: enrollmentState(dto),
    modelVersion: dto.model_version
  }
}

export async function enrollPerson(
  employeeId: string,
  clipsB64: string[],
  mimeType: string
): Promise<StaffMember | null> {
  const dto = await callRequired<PersonEnrollmentDto>('POST', `/people/${employeeId}/enroll`, {
    clips_b64: clipsB64,
    mime_type: mimeType
  })
  return {
    id: dto.employee_id,
    name: dto.display_name,
    role: dto.role,
    tone: toneFor(dto.display_name),
    enrollment: enrollmentState(dto),
    modelVersion: dto.model_version
  }
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
