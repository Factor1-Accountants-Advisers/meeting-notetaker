import { type LucideIcon } from 'lucide-react'
import type { Person } from '@renderer/components/ui/Avatar'
import type { Priority, Status } from '@renderer/components/ui/Pill'
import type { Tone } from '@renderer/components/ui/tones'

// Sample data: the deliberate offline fallback used by useLive() when the
// backend is unreachable (screens show a "sample data" notice). Keep shapes
// aligned with lib/api.ts mappings. Do not delete.

export interface UpcomingMeeting {
  id: string
  title: string
  time: string
  icon: LucideIcon
  tone: Tone
  attendees: Person[]
}

export interface Recording {
  id: string
  title: string
  date: string
  durationLabel: string
  durationBadge: string
}

export interface ActionItem {
  id: string
  description: string
  sourceMeeting: string
  meetingId: string | null // null when the source meeting has no review data yet
  owner: string | null // null = owned by an unnamed Unknown speaker
  dueLabel: string
  dueISO: string
  overdue: boolean
  priority: Priority
  status: Status
}

export type MeetingStatus = 'Draft' | 'Finalized'
export type PipelineStatus = 'pending_audio' | 'queued' | 'processing' | 'ready' | 'failed'
export type PipelineStage =
  | 'pending_audio'
  | 'audio_uploaded'
  | 'queued'
  | 'transcribing_diarizing'
  | 'identifying_speakers'
  | 'extracting_notes'
  | 'ready'
  | 'failed'
export type DeliveryStatus = 'not_started' | 'emailing' | 'emailed' | 'failed'

export interface Meeting {
  id: string
  title: string
  context: string // client name or "Internal"
  date: string
  durationMin: number
  actionItems: number
  status: MeetingStatus
  unknownSpeakers: number
  icon: LucideIcon
  tone: Tone
  attendees: Person[]
  group: 'Today' | 'Earlier this week' | 'Older'
  pipelineStatus: PipelineStatus
  pipelineStage: PipelineStage
  pipelineStageMessage: string
  deliveryStatus: DeliveryStatus
  deliveryErrorMessage: string | null
  source: 'online' | 'in_person' | 'upload'
}

export type EnrollmentState = 'enrolled' | 'not_enrolled' | 'reenroll_required'

export interface StaffMember {
  id: string
  name: string
  role: string
  tone: Tone
  enrollment: EnrollmentState
  modelVersion: string | null
}

export interface TranscriptSegment {
  id: string
  speaker: string // display name or "Unknown 1"
  known: boolean
  time: string
  text: string
}

export interface MeetingDetail {
  summary: string
  participants: { name: string; tone: Tone; unknown?: boolean }[]
  transcript: TranscriptSegment[]
  actionItems: ActionItem[]
}

export const upcomingMeetings: UpcomingMeeting[] = []

export const recordings: Recording[] = []

export const myActionItems: ActionItem[] = []

export const allActionItems: ActionItem[] = []

export const staff: StaffMember[] = []

export const staffNames: string[] = []

export const meetingDetails: Record<string, MeetingDetail> = {}

export const meetings: Meeting[] = []
