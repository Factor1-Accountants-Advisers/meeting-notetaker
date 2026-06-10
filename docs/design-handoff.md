# Meeting Notetaker — UI / Design Handoff

This document covers **how the app looks and is laid out**. It pairs with the
project requirements document (which covers *what* to build and *why*). Read
both before implementing UI.

The mockups in `mockups/` are **reference renders**, not the final code. They are
plain HTML so they open in a browser and are easy to read. Port them into the
real stack below — do not ship the raw HTML.

## Target stack

- Desktop shell: **Electron**
- UI: **React + Vite + Tailwind CSS**
- Icons: **lucide-react** (the mockups use the Tabler icon webfont as a stand-in;
  map each `ti-*` class to the closest lucide icon — see mapping below)
- State: React state/hooks; no browser storage in artifacts-style code — use real
  app state / IPC to the backend

## How to use the mockups

1. Treat each mockup as the **target layout and visual hierarchy**, not as final markup.
2. Rebuild each screen as React components using the component inventory below.
3. Replace the CSS variables in the mockup with **Tailwind theme tokens** seeded
   from the table below (extend `tailwind.config` `theme.extend.colors`).
4. Replace Tabler `<i class="ti ...">` icons with `lucide-react` components.
5. Keep the aesthetic rules (flat, minimal borders, two font weights, sentence case).

## Design tokens

Seed these into Tailwind. Brand colours come from the requirements doc.

| Token | Value | Use |
|---|---|---|
| brand-navy | `#1F3864` | primary accent text/icons, active nav |
| brand-blue | `#2E75B6` | focus rings, accent borders, links |
| bg-primary | `#ffffff` | cards, app surface |
| bg-secondary | `#f4f6f9` | top bar, subtle fills, avatar chips |
| bg-tertiary | `#eaeef3` | nav rail, thumbnails |
| bg-info | `#E7EEF6` | active states, primary button fill |
| bg-danger | `#FCEBEB` | overdue / unknown-speaker fills |
| bg-warning | `#FAEEDA` | medium priority fills |
| bg-success | `#EAF3DE` | success / low-risk fills |
| text-primary | `#1b1d21` | body, titles |
| text-secondary | `#565a61` | secondary labels |
| text-tertiary | `#8b9098` | meta, hints |
| text-info | `#1F3864` | accent text on info fill |
| text-danger | `#A32D2D` | overdue text/pills |
| text-warning | `#854F0B` | medium-priority text |
| text-success | `#3B6D11` | success text |
| border-tertiary | `rgba(20,24,31,0.12)` | default 0.5px borders |
| border-secondary | `rgba(20,24,31,0.20)` | emphasis borders |
| radius-md | `8px` | controls, small elements |
| radius-lg | `12px` | cards |

Typography: system sans stack. **Two weights only — 400 and 500** (never 600/700).
Sizes: title 22px, section header 13px/500, body 14px, meta 11–12px.
Casing: **sentence case everywhere** (no Title Case, no ALL CAPS).
Surfaces are flat: **no gradients, no drop shadows** (focus rings only).

**Dark mode**: both themes ship. Mockups implement it via `prefers-color-scheme`;
the app should implement it with Tailwind `dark:` variants over the same token
pairs (dark values are in the `:root` override block of any mockup file).

## Layout system

Every screen sits in an app shell:

- **Top bar** (~40px): window controls, app name, right-aligned search / bell / avatar.
- **Left icon rail** (56px, `bg-tertiary`, right border), five items: Home
  (layout-grid), Meetings (file-text), Action items (list-check), People (users),
  Settings (settings, bottom-pinned). Active item = `bg-info` + `text-info`.
  Global search is a visible field in the top bar ("Search all meetings"), not a rail tab.
- **Content area**: max content width ~580px inside the rail; padding 18px.
- **Card**: `bg-primary`, `0.5px solid border-tertiary`, `radius-lg`, padding 14–16px.
  Section header inside a card is 13px/500 with a leading icon.

## Component inventory

- `AppShell` — top bar + icon rail + content slot
- `NavRail` / `NavItem` (active state)
- `Greeting` — date line + "Good morning, {name}"
- `CaptureCard` — meeting-name input, optional meeting-link input with platform
  icons (Teams/Zoom/Meet), primary "Start capturing" button. The link is
  optional and only auto-fills title/attendees via Graph — capture itself is
  loopback + mic (no meeting bot in v1).
- `DayStrip` — 5–7 day selector, selected day = `bg-info`
- `MeetingListRow` — coloured square icon, title, time, overlapping avatar stack (+N)
- `RecordingTile` — waveform thumbnail (audio-first; not video), duration badge,
  title, date · length
- `ActionItemRow` — checkbox, description, "{source meeting} · due {date}",
  priority pill, status pill. Overdue → red due-date + danger "Overdue" pill +
  a count badge in the section header.
- `Pill` — variants: priority (High=danger, Medium=warning, Low=secondary),
  status (Open=secondary, Overdue=danger, Done=success)
- `Avatar` — initials circle; colour by person; 1.5px white ring when stacked
- `UnknownSpeakerFlag` — danger-styled chip/segment with a "Name" action
  (used on the review screen and anywhere a speaker is unmatched)

## Screen inventory

| Screen | Status | Notes |
|---|---|---|
| Home / dashboard | mockup ready (`mockups/home-screen.html`) | greeting, capture, upcoming, recordings, your action items |
| Meetings (library) | mockup ready (`mockups/meetings.html`) | All/Drafts/Finalized filter, recency groups, status pills, 'N to name' flags |
| Meeting review | mockup ready (see chat / export on request) | summary, action items, transcript with named + unknown speakers, Draft → Finalize |
| Action items (cross-meeting) | not yet designed | filter by owner/status/priority/overdue, links to source meeting |
| Recording in progress | not yet designed | live indicator, pause/resume/stop, elapsed time |
| Voiceprint enrollment | not yet designed | 3-clip capture, consent handled out-of-app |
| Login | not yet designed | Microsoft sign-in, authorisation check |

## Behaviours the UI must reflect (from requirements)

- **Draft → Finalize gating**: a meeting stays in Draft until the user finalizes;
  email distribution is only available after finalize. Make Draft state and the
  Finalize action visually primary.
- **Unknown speakers are surfaced, not hidden**: any unmatched speaker is flagged
  for manual naming in the transcript, the participant list, and (if it owns an
  action item) the action item.
- **Action items carry source meeting, owner, deadline, priority, status** and are
  tracked entirely in-app (no external task tool in v1).
- **Audio-first**: recordings are audio; avoid video affordances.

## Icon mapping (Tabler → lucide-react)

| Tabler (`ti-*`) | lucide-react |
|---|---|
| layout-grid | LayoutGrid |
| file-text | FileText |
| microphone | Mic |
| users | Users |
| settings | Settings |
| search | Search |
| bell | Bell |
| plus | Plus |
| user-plus | UserPlus |
| calendar | Calendar |
| player-record | Circle (filled) / Disc |
| waveform | AudioWaveform |
| checkbox | CheckSquare |
| circle | Circle |
| help / user-question | HelpCircle / UserRoundSearch |
| brand-teams / brand-zoom / brand-google | use simple-icons or text labels |
