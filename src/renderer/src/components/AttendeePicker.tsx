import { useMemo, useState } from 'react'
import { UserPlus, X } from 'lucide-react'
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
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Selected attendees">
          <span className="text-[14px] font-medium text-content-tertiary">Attendees:</span>
          {selected.map((attendee) => {
            const label = attendee.name || attendee.email
            return (
              <span
                key={attendee.email}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-bg-info py-1 pl-2.5 pr-1.5 text-[12px] text-content-info"
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

      <label
        htmlFor="manual-attendees"
        className="mb-1.5 block text-[14px] font-medium text-content-primary"
      >
        Add another person
      </label>
      <div className="relative">
        <input
          id="manual-attendees"
          type="text"
          value={query}
          disabled={disabled || selected.length >= MAX_MANUAL_ATTENDEES}
          aria-label="Search or add attendee"
          autoComplete="off"
          placeholder="Search staff or enter a work email"
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
          className="ui-control h-7 w-full rounded-control border border-edge-tertiary bg-bg-secondary px-2 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
        />

        {showMenu && (
          <div className="ui-popover absolute z-20 mt-1 w-full overflow-hidden rounded-[9px] border border-edge-secondary bg-[var(--color-background-popover)] p-1">
            {suggestions.map((person) => (
              <button
                key={person.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose({ name: person.name, email: person.id })}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-bg-info focus:bg-bg-info focus:outline-none"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-info text-[10px] font-medium text-content-info">
                  {initials(person.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-content-primary">
                    {person.name}
                  </span>
                  <span className="block truncate text-[12px] text-content-tertiary">
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
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-bg-info focus:bg-bg-info focus:outline-none"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-secondary text-content-secondary">
                  <UserPlus size={13} strokeWidth={1.75} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] text-content-primary">Add by email</span>
                  <span className="block truncate text-[12px] text-content-tertiary">
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
          className={`mb-0 mt-1.5 text-[12px] ${
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
