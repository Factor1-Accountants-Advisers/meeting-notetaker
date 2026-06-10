import {
  Banknote,
  Calculator,
  ReceiptText,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { Person } from '@renderer/components/ui/Avatar'
import type { Priority, Status } from '@renderer/components/ui/Pill'
import type { Tone } from '@renderer/components/ui/tones'

// Placeholder data matching the mockups. Replaced by the FastAPI backend later;
// keep shapes close to the indicative schema in requirements §6.1.

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
  dueLabel: string
  overdue: boolean
  priority: Priority
  status: Status
}

export type MeetingStatus = 'Draft' | 'Finalized'

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
  group: 'Today' | 'Earlier this week'
}

export const upcomingMeetings: UpcomingMeeting[] = [
  {
    id: 'u1',
    title: "Accounts review — Smith's Bakery",
    time: '9:00 – 10:30',
    icon: Calculator,
    tone: 'info',
    attendees: [
      { initials: 'MS', tone: 'success' },
      { initials: 'JL', tone: 'warning' },
      { initials: 'AB', tone: 'info' },
      { initials: 'CD', tone: 'secondary' }
    ]
  },
  {
    id: 'u2',
    title: 'Stand-up with accounting',
    time: '11:00 – 11:30',
    icon: Users,
    tone: 'success',
    attendees: [
      { initials: 'RA', tone: 'info' },
      { initials: 'EF', tone: 'warning' },
      { initials: 'GH', tone: 'success' },
      { initials: 'IJ', tone: 'secondary' }
    ]
  },
  {
    id: 'u3',
    title: 'Tax compliance — Henderson',
    time: '14:00 – 15:00',
    icon: ReceiptText,
    tone: 'warning',
    attendees: [
      { initials: 'MS', tone: 'info' },
      { initials: 'KL', tone: 'success' }
    ]
  },
  {
    id: 'u4',
    title: 'Payroll discussion — HR',
    time: '16:00 – 16:30',
    icon: Banknote,
    tone: 'secondary',
    attendees: [
      { initials: 'LP', tone: 'warning' },
      { initials: 'SW', tone: 'success' }
    ]
  }
]

export const recordings: Recording[] = [
  { id: 'r1', title: 'Q2 review — Henderson', date: '9 Jun', durationLabel: '42 min', durationBadge: '42:10' },
  { id: 'r2', title: 'Daily stand-up', date: '8 Jun', durationLabel: '12 min', durationBadge: '12:30' },
  { id: 'r3', title: 'Tax compliance — Acme', date: '6 Jun', durationLabel: '35 min', durationBadge: '35:02' },
  { id: 'r4', title: 'Payroll discussion', date: '4 Jun', durationLabel: '29 min', durationBadge: '28:44' }
]

export const myActionItems: ActionItem[] = [
  {
    id: 'a1',
    description: "Reconcile Smith's Bakery accounts",
    sourceMeeting: 'Accounts review',
    dueLabel: 'due 6 Jun',
    overdue: true,
    priority: 'High',
    status: 'Overdue'
  },
  {
    id: 'a2',
    description: 'Update depreciation schedule',
    sourceMeeting: 'Q2 review — Henderson',
    dueLabel: 'due 13 Jun',
    overdue: false,
    priority: 'Medium',
    status: 'Open'
  },
  {
    id: 'a3',
    description: 'Send FY25 provisional tax estimate',
    sourceMeeting: 'Tax compliance — Henderson',
    dueLabel: 'due 16 Jun',
    overdue: false,
    priority: 'Medium',
    status: 'Open'
  },
  {
    id: 'a4',
    description: 'Draft payroll summary for HR',
    sourceMeeting: 'Payroll discussion',
    dueLabel: 'due 18 Jun',
    overdue: false,
    priority: 'Low',
    status: 'Open'
  }
]

export const meetings: Meeting[] = [
  {
    id: 'm1',
    title: 'Q2 review — Henderson & Co',
    context: 'Henderson & Co',
    date: '9 Jun',
    durationMin: 42,
    actionItems: 3,
    status: 'Draft',
    unknownSpeakers: 1,
    icon: ReceiptText,
    tone: 'info',
    attendees: [
      { initials: 'MS', tone: 'info' },
      { initials: 'JL', tone: 'success' }
    ],
    group: 'Today'
  },
  {
    id: 'm2',
    title: 'Daily stand-up',
    context: 'Internal',
    date: '8 Jun',
    durationMin: 12,
    actionItems: 2,
    status: 'Finalized',
    unknownSpeakers: 0,
    icon: Users,
    tone: 'success',
    attendees: [
      { initials: 'RA', tone: 'info' },
      { initials: 'EF', tone: 'warning' },
      { initials: 'GH', tone: 'success' },
      { initials: 'IJ', tone: 'secondary' }
    ],
    group: 'Earlier this week'
  },
  {
    id: 'm3',
    title: 'Tax compliance — Acme Retail',
    context: 'Acme Retail',
    date: '6 Jun',
    durationMin: 35,
    actionItems: 4,
    status: 'Finalized',
    unknownSpeakers: 0,
    icon: Calculator,
    tone: 'warning',
    attendees: [
      { initials: 'MS', tone: 'info' },
      { initials: 'CF', tone: 'warning' },
      { initials: 'KL', tone: 'secondary' }
    ],
    group: 'Earlier this week'
  },
  {
    id: 'm4',
    title: 'Payroll discussion — HR',
    context: 'Internal',
    date: '4 Jun',
    durationMin: 29,
    actionItems: 1,
    status: 'Finalized',
    unknownSpeakers: 0,
    icon: Banknote,
    tone: 'secondary',
    attendees: [
      { initials: 'LP', tone: 'warning' },
      { initials: 'SW', tone: 'success' }
    ],
    group: 'Earlier this week'
  }
]
