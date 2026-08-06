// Popover placement maths shared by dropdown-style menus (SelectMenu's flip-up
// behaviour, ported for AttendeePicker's suggestion menu).
//
// Kept pure and separate from the components so the verify scripts can assert
// the geometry directly — `renderToStaticMarkup` never runs layout effects, so
// this logic is untestable while it lives inside a component.

/** Tallest a menu may grow before it scrolls internally. */
export const MENU_MAX_HEIGHT = 240
/** Never squeeze a menu below this; better to overlap slightly than show a sliver. */
export const MENU_MIN_HEIGHT = 72
/** Breathing room between the anchor and the scroll viewport's edge. */
export const MENU_VIEWPORT_GAP = 8
/** Menu container's own vertical padding. */
export const MENU_PADDING = 10
/** SelectMenu's single-line rows. */
export const SELECT_ROW_HEIGHT = 38
/** AttendeePicker's two-line rows (avatar + name + email). */
export const SUGGESTION_ROW_HEIGHT = 52

export interface MenuPlacementInput {
  /** Anchor's viewport-relative top edge (`getBoundingClientRect().top`). */
  anchorTop: number
  /** Anchor's viewport-relative bottom edge. */
  anchorBottom: number
  /** Top of the scrolling viewport the menu must stay inside. */
  viewportTop: number
  /** Bottom of that viewport. */
  viewportBottom: number
  itemCount: number
  itemHeight?: number
  maxHeight?: number
  minHeight?: number
  gap?: number
  padding?: number
}

export interface MenuPlacement {
  /** Render above the anchor instead of below it. */
  openUp: boolean
  /** Cap for the menu's height; the menu scrolls internally past this. */
  maxHeight: number
}

/**
 * Decide whether a menu opens up or down and how tall it may be.
 *
 * Flips up only when the menu genuinely does not fit below AND there is more
 * room above — so a menu that fits below always opens downward, which keeps the
 * common case visually stable.
 *
 * `itemHeight` only estimates whether the menu fits; the returned `maxHeight`
 * plus internal scrolling is what actually constrains it, so an imprecise row
 * height can at worst flip a borderline menu the "wrong" way, never clip it.
 */
export function computeMenuPlacement({
  anchorTop,
  anchorBottom,
  viewportTop,
  viewportBottom,
  itemCount,
  itemHeight = SELECT_ROW_HEIGHT,
  maxHeight = MENU_MAX_HEIGHT,
  minHeight = MENU_MIN_HEIGHT,
  gap = MENU_VIEWPORT_GAP,
  padding = MENU_PADDING
}: MenuPlacementInput): MenuPlacement {
  const estimatedMenuHeight = Math.min(maxHeight, itemCount * itemHeight + padding)
  const spaceBelow = Math.max(0, viewportBottom - anchorBottom - gap)
  const spaceAbove = Math.max(0, anchorTop - viewportTop - gap)
  const openUp = estimatedMenuHeight > spaceBelow && spaceAbove > spaceBelow
  return {
    openUp,
    maxHeight: Math.max(minHeight, Math.min(maxHeight, openUp ? spaceAbove : spaceBelow))
  }
}

/**
 * Wrap-around active-option index for ArrowUp/ArrowDown, matching SelectMenu.
 * Returns 0 for an empty list so callers can index safely.
 */
export function nextActiveIndex(current: number, direction: 1 | -1, count: number): number {
  if (count <= 0) return 0
  return (current + direction + count) % count
}

/** Clamp a remembered index onto a list that may have shrunk under it. */
export function clampActiveIndex(current: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(0, current), count - 1)
}
