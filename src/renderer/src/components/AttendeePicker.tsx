import { useMemo, useState } from 'react'
import { Search, UserPlus, X } from 'lucide-react'
import type { StaffMember } from '@renderer/data/mock'

export const MAX_MANUAL_ATTENDEES = 49

export interface ManualAttendee {
  name: string | null
  email: string
}

interface AttendeePickerProps {
  people: StaffMember[]
  selected: ManualAttendee[]
  onChange: (attendees: ManualAttendee[]) => void
  disabled?: boolean
  directoryUnavailable?: boolean
}

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-AU')
}

export function isValidAttendeeEmail(value: string): boolean {
  const email = normalizeEmail(value)
  const parts = email.split('@')
  return (
    parts.length === 2 &&
    parts[0].length > 0 &&
    parts[1].includes('.') &&
    !/\s/.test(email)
  )
}

export function addAttendee(
  selected: ManualAttendee[],
  attendee: { name?: string | null; email: string }
): ManualAttendee[] {
  const email = normalizeEmail(attendee.email)
  if (
    selected.length >= MAX_MANUAL_ATTENDEES ||
    !isValidAttendeeEmail(email) ||
    selected.some((item) => item.email === email)
  ) {
    return selected
  }
  const normalizedName = attendee.name?.trim() || null
  return [...selected, { name: normalizedName, email }]
}

export function filterAttendeeSuggestions(
  people: StaffMember[],
  query: string,
  selected: ManualAttendee[]
): StaffMember[] {
  const needle = query.trim().toLocaleLowerCase('en-AU')
  const selectedEmails = new Set(selected.map((attendee) => attendee.email))
  return people
    .filter((person) => person.enrollment === 'enrolled')
    .filter((person) => !selectedEmails.has(normalizeEmail(person.id)))
    .filter((person) => {
      if (!needle) return true
      return (
        person.name.toLocaleLowerCase('en-AU').includes(needle) ||
        person.id.toLocaleLowerCase('en-AU').includes(needle)
      )
    })
    .slice(0, 6)
}

export function AttendeePicker({
  people,
  selected,
  onChange,
  disabled = false,
  directoryUnavailable = false
}: AttendeePickerProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const suggestions = useMemo(
    () => filterAttendeeSuggestions(people, query, selected),
    [people, query, selected]
  )
  const normalizedQuery = normalizeEmail(query)
  const canAddTypedEmail =
    isValidAttendeeEmail(normalizedQuery) &&
    selected.length < MAX_MANUAL_ATTENDEES &&
    !selected.some((attendee) => attendee.email === normalizedQuery) &&
    !suggestions.some((person) => normalizeEmail(person.id) === normalizedQuery)
  const showMenu = focused && !disabled && (suggestions.length > 0 || canAddTypedEmail)

  const choose = (attendee: { name?: string | null; email: string }): void => {
    const next = addAttendee(selected, attendee)
    if (next === selected) {
      setMessage(
        selected.length >= MAX_MANUAL_ATTENDEES
          ? `You can select up to ${MAX_MANUAL_ATTENDEES} people.`
          : 'That person is already selected.'
      )
      return
    }
    onChange(next)
    setQuery('')
    setMessage(null)
  }

  const addFromInput = (): void => {
    if (suggestions.length > 0) {
      const first = suggestions[0]
      choose({ name: first.name, email: first.id })
      return
    }
    if (canAddTypedEmail) {
      choose({ name: null, email: normalizedQuery })
      return
    }
    if (query.trim()) {
      setMessage('Enter a complete work email or choose a known staff member.')
    }
  }

  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor="manual-attendees" className="text-[12px] text-content-secondary">
          People attending
        </label>
        <span className="text-[11px] text-content-tertiary">
          Optional · improves speaker matching
        </span>
      </div>

      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Selected attendees">
          {selected.map((attendee) => {
            const label = attendee.name || attendee.email
            return (
              <span
                key={attendee.email}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border-[0.5px] border-edge-info bg-bg-info py-1 pl-2.5 pr-1.5 text-[12px] text-content-info"
              >
                <span className="truncate">{label}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${label}`}
                  onClick={() =>
                    onChange(selected.filter((item) => item.email !== attendee.email))
                  }
                  className="rounded-full p-0.5 hover:bg-bg-secondary focus:outline-none focus:ring-1 focus:ring-edge-info disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <X size={12} strokeWidth={1.75} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-content-tertiary"
          size={14}
          strokeWidth={1.75}
        />
        <input
          id="manual-attendees"
          type="text"
          value={query}
          disabled={disabled || selected.length >= MAX_MANUAL_ATTENDEES}
          aria-label="Search or add attendee"
          autoComplete="off"
          placeholder="Search staff or enter their work email"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setQuery(event.target.value)
            setMessage(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addFromInput()
            }
          }}
          className="h-9 w-full rounded-md border-[0.5px] border-edge-tertiary bg-bg-primary pl-9 pr-3 text-[13px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
        />

        {showMenu && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border-[0.5px] border-edge-secondary bg-bg-primary">
            {suggestions.map((person) => (
              <button
                key={person.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose({ name: person.name, email: person.id })}
                className="flex w-full items-center gap-2.5 border-b-[0.5px] border-edge-tertiary px-3 py-2 text-left last:border-b-0 hover:bg-bg-secondary focus:bg-bg-secondary focus:outline-none"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-info text-[10px] font-medium text-content-info">
                  {initials(person.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-content-primary">
                    {person.name}
                  </span>
                  <span className="block truncate text-[11px] text-content-tertiary">
                    {person.id}
                  </span>
                </span>
              </button>
            ))}
            {canAddTypedEmail && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose({ name: null, email: normalizedQuery })}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-secondary focus:bg-bg-secondary focus:outline-none"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-secondary text-content-secondary">
                  <UserPlus size={13} strokeWidth={1.75} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] text-content-primary">Add by email</span>
                  <span className="block truncate text-[11px] text-content-tertiary">
                    {normalizedQuery}
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {(message || directoryUnavailable || selected.length >= MAX_MANUAL_ATTENDEES) && (
        <p
          className={`mb-0 mt-1.5 text-[11px] ${
            message ? 'text-content-danger' : 'text-content-tertiary'
          }`}
        >
          {message ||
            (selected.length >= MAX_MANUAL_ATTENDEES
              ? `Maximum ${MAX_MANUAL_ATTENDEES} people selected.`
              : 'Staff suggestions are unavailable; you can still enter an exact work email.')}
        </p>
      )}
    </div>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toLocaleUpperCase('en-AU')
    .slice(0, 2)
}
