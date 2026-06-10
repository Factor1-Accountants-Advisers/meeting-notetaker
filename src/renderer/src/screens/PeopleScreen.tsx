import { useEffect, useState } from 'react'
import { CloudOff, Mic, RefreshCw, ShieldCheck } from 'lucide-react'
import { Card } from '@renderer/components/ui/Card'
import { Pill } from '@renderer/components/ui/Pill'
import { Avatar } from '@renderer/components/ui/Avatar'
import { fetchPeople } from '@renderer/lib/api'
import { staff as sampleStaff, type EnrollmentState, type StaffMember } from '@renderer/data/mock'
import type { Tone } from '@renderer/components/ui/tones'

const enrollmentLabel: Record<EnrollmentState, { text: string; tone: Tone }> = {
  enrolled: { text: 'Enrolled', tone: 'success' },
  not_enrolled: { text: 'Not enrolled', tone: 'secondary' },
  reenroll_required: { text: 'Re-enrollment required', tone: 'warning' }
}

export function PeopleScreen(): JSX.Element {
  const [staff, setStaff] = useState<StaffMember[]>(sampleStaff)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchPeople().then((live) => {
      if (cancelled) return
      if (live) setStaff(live)
      else setOffline(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const enrolledCount = staff.filter((s) => s.enrollment === 'enrolled').length

  return (
    <div>
      <div className="mb-3.5">
        <h1 className="text-[22px] font-medium text-content-primary">
          People{' '}
          <span className="text-[14px] font-normal text-content-tertiary">
            · {enrolledCount} of {staff.length} enrolled
          </span>
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-content-tertiary">
          <ShieldCheck size={13} strokeWidth={1.75} />
          Staff only. Voiceprints are stored as encrypted embeddings and deleted on
          offboarding; clients and external attendees are never enrolled.
        </p>
        {offline && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-content-warning">
            <CloudOff size={13} strokeWidth={1.75} />
            Backend unavailable — showing sample data.
          </p>
        )}
      </div>

      <Card className="!py-1">
        {staff.map((person, i) => (
          <PersonRow key={person.id} person={person} divider={i > 0} />
        ))}
      </Card>
    </div>
  )
}

function PersonRow({ person, divider }: { person: StaffMember; divider: boolean }): JSX.Element {
  const state = enrollmentLabel[person.enrollment]
  const initials = person.name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .replace('.', '')
    .toUpperCase()
    .slice(0, 2)

  return (
    <div
      className={`flex items-center gap-2.5 py-2.5 ${
        divider ? 'border-t-[0.5px] border-edge-tertiary' : ''
      }`}
    >
      <Avatar initials={initials} tone={person.tone} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-content-primary">{person.name}</div>
        <div className="text-[11px] text-content-tertiary">
          {person.role}
          {person.modelVersion && ` · ${person.modelVersion}`}
        </div>
      </div>
      <Pill tone={state.tone}>{state.text}</Pill>
      {person.enrollment !== 'enrolled' && (
        <button
          type="button"
          title="Record three short clips to enroll"
          className="flex shrink-0 items-center gap-1.5 rounded-md border-[0.5px] border-edge-secondary px-2.5 py-1.5 text-[12px] text-content-primary hover:bg-bg-secondary"
        >
          {person.enrollment === 'reenroll_required' ? (
            <RefreshCw size={13} strokeWidth={1.75} />
          ) : (
            <Mic size={13} strokeWidth={1.75} />
          )}
          {person.enrollment === 'reenroll_required' ? 'Re-enroll' : 'Enroll'}
        </button>
      )}
    </div>
  )
}
