import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { UserPlus, X } from 'lucide-react'
import {
  MENU_MAX_HEIGHT,
  SUGGESTION_ROW_HEIGHT,
  clampActiveIndex,
  computeMenuPlacement,
  nextActiveIndex,
  type MenuPlacement
} from '@renderer/lib/menuPlacement'
import type { StaffMember } from '@renderer/data/mock'

export const MAX_MANUAL_ATTENDEES = 49

export interface ManualAttendee {
  name: string | null
  email: string
}

// Placement must be measured before paint so the menu never flashes in the
// wrong spot; the verify scripts render this through react-dom/server, where
// useLayoutEffect is a no-op that warns, so fall back to useEffect there.
const useMenuLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** One row of the suggestion menu: a staff match, or the "add by email" row. */
interface AttendeeMenuItem {
  key: string
  person: StaffMember | null
  attendee: { name: string | null; email: string }
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
  // Escape hides the menu without blurring the input, so the user can keep
  // typing; any edit or refocus brings the suggestions back.
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [placement, setPlacement] = useState<MenuPlacement>({
    openUp: false,
    maxHeight: MENU_MAX_HEIGHT
  })
  const anchorRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
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

  // One flat list so arrow keys traverse the staff rows and the "Add by email"
  // row alike; index 0 stays the first suggestion, preserving Enter's old
  // behaviour of taking the top match.
  const menuItems = useMemo<AttendeeMenuItem[]>(() => {
    const items: AttendeeMenuItem[] = suggestions.map((person) => ({
      key: person.id,
      person,
      attendee: { name: person.name, email: person.id }
    }))
    if (canAddTypedEmail) {
      items.push({
        key: `add-by-email:${normalizedQuery}`,
        person: null,
        attendee: { name: null, email: normalizedQuery }
      })
    }
    return items
  }, [suggestions, canAddTypedEmail, normalizedQuery])

  const showMenu = focused && !dismissed && !disabled && menuItems.length > 0
  const safeActiveIndex = clampActiveIndex(activeIndex, menuItems.length)

  // Re-point at the top match whenever the list itself changes underneath.
  useEffect(() => {
    setActiveIndex(0)
  }, [normalizedQuery, menuItems.length])

  useMenuLayoutEffect(() => {
    if (!showMenu || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const scrollViewport = anchorRef.current.closest('main')?.getBoundingClientRect()
    setPlacement(
      computeMenuPlacement({
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        viewportTop: scrollViewport?.top ?? 0,
        viewportBottom: scrollViewport?.bottom ?? window.innerHeight,
        itemCount: menuItems.length,
        itemHeight: SUGGESTION_ROW_HEIGHT
      })
    )
  }, [showMenu, menuItems.length])

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
    // menuItems already collapses "top suggestion" and "add the typed email"
    // into one ordered list, so the highlighted row is the whole decision.
    const item = menuItems[safeActiveIndex]
    if (item) {
      choose(item.attendee)
      return
    }
    if (query.trim()) {
      setMessage('Enter a complete work email or choose a known staff member.')
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (!showMenu) return
      event.preventDefault()
      setDismissed(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (menuItems.length === 0) return
      event.preventDefault()
      if (!showMenu) {
        // Re-open a menu the user dismissed, without moving the selection.
        setDismissed(false)
        return
      }
      setActiveIndex((current) =>
        nextActiveIndex(
          clampActiveIndex(current, menuItems.length),
          event.key === 'ArrowDown' ? 1 : -1,
          menuItems.length
        )
      )
      return
    }
    // Deliberately no Space handling: SelectMenu selects on Space, but this
    // anchor is a text input where Space must stay a literal character.
    if (event.key === 'Enter') {
      event.preventDefault()
      addFromInput()
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
      <div ref={anchorRef} className="relative">
        <input
          id="manual-attendees"
          type="text"
          value={query}
          disabled={disabled || selected.length >= MAX_MANUAL_ATTENDEES}
          aria-label="Search or add attendee"
          role="combobox"
          aria-expanded={showMenu}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            showMenu ? `${listboxId}-option-${safeActiveIndex}` : undefined
          }
          autoComplete="off"
          placeholder="Search staff or enter a work email"
          onFocus={() => {
            setFocused(true)
            setDismissed(false)
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setQuery(event.target.value)
            setMessage(null)
            setDismissed(false)
          }}
          onKeyDown={handleKeyDown}
          className="ui-control h-7 w-full rounded-control border border-edge-tertiary bg-bg-secondary px-2 text-[14px] text-content-primary placeholder:text-content-tertiary focus:border-brand-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
        />

        {showMenu && (
          <div
            id={listboxId}
            role="listbox"
            aria-label="Attendee suggestions"
            style={{ maxHeight: `${placement.maxHeight}px` }}
            className={`ui-popover absolute z-20 w-full overflow-y-auto rounded-[9px] border border-edge-secondary bg-[var(--color-background-popover)] p-1 ${
              placement.openUp ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]'
            }`}
          >
            {menuItems.map((item, index) => {
              const active = index === safeActiveIndex
              const rowClass = `flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left focus:outline-none ${
                active ? 'bg-bg-info' : 'hover:bg-bg-info'
              }`
              return item.person ? (
                <button
                  key={item.key}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item.attendee)}
                  className={rowClass}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-info text-[10px] font-medium text-content-info">
                    {initials(item.person.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-content-primary">
                      {item.person.name}
                    </span>
                    <span className="block truncate text-[12px] text-content-tertiary">
                      {item.person.id}
                    </span>
                  </span>
                </button>
              ) : (
                <button
                  key={item.key}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item.attendee)}
                  className={rowClass}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-secondary text-content-secondary">
                    <UserPlus size={13} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] text-content-primary">Add by email</span>
                    <span className="block truncate text-[12px] text-content-tertiary">
                      {item.attendee.email}
                    </span>
                  </span>
                </button>
              )
            })}
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
