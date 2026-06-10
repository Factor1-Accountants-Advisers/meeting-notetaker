import type { Tone } from '@renderer/components/ui/tones'
import type { EnrollmentState, StaffMember } from '@renderer/data/mock'

/** Backend wire shape (backend/app/schemas.py PersonEnrollment). */
interface PersonEnrollmentDto {
  employee_id: string
  display_name: string
  role: string
  enrolled: boolean
  model_version: string | null
  reenrollment_required: boolean
}

const PREFIX = '/api/v1'

/** Stable tone from a name so avatar colours don't shuffle between renders. */
const TONES: Tone[] = ['info', 'success', 'warning', 'danger', 'secondary']
function toneFor(name: string): Tone {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return TONES[Math.abs(hash) % TONES.length]
}

function enrollmentState(dto: PersonEnrollmentDto): EnrollmentState {
  if (dto.reenrollment_required) return 'reenroll_required'
  return dto.enrolled ? 'enrolled' : 'not_enrolled'
}

/**
 * Fetch staff enrollment list from the backend.
 * Returns null when the backend is unreachable — callers fall back to sample data.
 */
export async function fetchPeople(): Promise<StaffMember[] | null> {
  const res = await window.api.request<PersonEnrollmentDto[]>('GET', `${PREFIX}/people`)
  if (!res.ok || res.body === null) return null
  return res.body.map((dto) => ({
    id: dto.employee_id,
    name: dto.display_name,
    role: dto.role,
    tone: toneFor(dto.display_name),
    enrollment: enrollmentState(dto),
    modelVersion: dto.model_version
  }))
}
