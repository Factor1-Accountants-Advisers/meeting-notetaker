import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectMenuProps<T extends string> {
  ariaLabel: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  className?: string
}

export function SelectMenu<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  className = ''
}: SelectMenuProps<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuPlacement, setMenuPlacement] = useState({ openUp: false, maxHeight: 240 })
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value)
    )
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [])

  useEffect(() => {
    if (!open) return
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value)
      )
    )
  }, [open, options, value])

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    const scrollViewport = rootRef.current.closest('main')?.getBoundingClientRect()
    const viewportTop = scrollViewport?.top ?? 0
    const viewportBottom = scrollViewport?.bottom ?? window.innerHeight
    const estimatedMenuHeight = Math.min(240, options.length * 38 + 10)
    const spaceBelow = Math.max(0, viewportBottom - rect.bottom - 8)
    const spaceAbove = Math.max(0, rect.top - viewportTop - 8)
    const openUp = estimatedMenuHeight > spaceBelow && spaceAbove > spaceBelow
    setMenuPlacement({
      openUp,
      maxHeight: Math.max(72, Math.min(240, openUp ? spaceAbove : spaceBelow))
    })
  }, [open, options.length])

  const choose = (index: number): void => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + direction + options.length) % options.length)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      choose(activeIndex)
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        className={`ui-control flex h-9 w-full min-w-0 items-center justify-between gap-3 whitespace-nowrap rounded-md border px-3 text-left text-[14px] text-content-primary ${
          open
            ? 'border-edge-info bg-bg-info'
            : 'border-edge-tertiary bg-bg-secondary hover:bg-bg-tertiary'
        }`}
      >
        <span className="truncate">{selected?.label}</span>
        <ChevronDown
          size={15}
          strokeWidth={1.75}
          className={`shrink-0 text-content-tertiary transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          style={{ maxHeight: `${menuPlacement.maxHeight}px` }}
          className={`ui-popover absolute right-0 z-50 w-full overflow-y-auto rounded-[9px] border border-edge-secondary bg-[var(--color-background-popover)] p-1 ${
            menuPlacement.openUp ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]'
          }`}
        >
          {options.map((option, index) => {
            const checked = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={checked}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-center justify-between gap-4 whitespace-nowrap rounded-sm px-2.5 py-2 text-left text-[14px] transition-colors duration-150 ${
                  activeIndex === index
                    ? 'bg-bg-info text-content-info'
                    : 'text-content-primary hover:bg-bg-secondary'
                }`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {checked && <Check size={14} strokeWidth={1.75} className="shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
