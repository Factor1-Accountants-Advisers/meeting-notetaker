# Meeting Notetaker — UI / Design Handoff

This document covers **how the app looks and is laid out**. It pairs with the
project requirements document (which covers *what* to build and *why*). Read
both before implementing UI.

The approved compact interactive HTML review package is the visual source of
truth for Home, Recording, Settings, advanced settings, and Report a problem.
The older files in `mockups/` are retained as historical reference renders and
must not override the approved compact direction. Do not ship either raw HTML
artifact.

## Target stack

- Desktop shell: **Electron**
- UI: **React + Vite + Tailwind CSS**
- Icons: **lucide-react** (the mockups use the Tabler icon webfont as a stand-in;
  map each `ti-*` class to the closest lucide icon — see mapping below)
- State: React state/hooks; no browser storage in artifacts-style code — use real
  app state / IPC to the backend

## How to use the mockups

1. Treat the approved compact HTML as the **target layout and visual hierarchy**.
   Use the legacy mockups only for flows not represented in that package.
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
| page | `#ffffff` | app canvas |
| bg-primary | `rgba(26,28,31,0.05)` | flat cards |
| bg-secondary | `rgba(255,255,255,0.96)` | controls |
| bg-tertiary | `#f1f2f3` | control hover |
| bg-info | `#E5F2FF` | active states |
| bg-danger | `#FCEBEB` | overdue / unknown-speaker fills |
| bg-warning | `#FAEEDA` | medium priority fills |
| bg-success | `#EAF3DE` | success / low-risk fills |
| text-primary | `#1a1c1f` | body, titles |
| text-secondary | `rgba(26,28,31,0.64)` | secondary labels |
| text-tertiary | `rgba(26,28,31,0.49)` | meta, hints |
| text-info | `#339CFF` | accent text on info fill |
| text-danger | `#A32D2D` | overdue text/pills |
| text-warning | `#854F0B` | medium-priority text |
| text-success | `#3B6D11` | success text |
| border-tertiary | `rgba(26,28,31,0.08)` | row separators and subtle control borders |
| border-secondary | `rgba(26,28,31,0.12)` | emphasis borders |
| radius-md | `8px` | icon buttons and selects |
| radius-control | `12px` | text fields and action buttons |
| radius-card | `20px` | cards and modals |

Typography: locally bundled **Inter**, with the system sans stack as fallback.
The renderer must not fetch fonts from the network. **Two weights only — 400
and 500** (never 600/700). The approved HTML's nominal 430 body weight maps to
the bundled 400 face to preserve this rule.
Sizes: h1 24px/1.25, h2 20px/1.25, h3 18px/1.3, body and labels 14px/1.5,
and supporting text 12px.
Casing: **sentence case everywhere** (no Title Case, no ALL CAPS).
Surfaces are flat: **no gradients, no drop shadows** (focus rings only).

**Dark mode**: both themes ship. The renderer uses the `.dark` class and the
same semantic tokens rather than fetching or branching on remote theme assets.

The approved compact HTML direction refines the dark presentation without
changing the underlying Factor1 brand hues:

- App canvas: `#181818`
- Card fill: `rgba(255,255,255,0.05)`
- Top-bar fill: `rgba(255,255,255,0.10)`
- Control fill: `rgba(54,54,54,0.96)`; hover fill `#424242`
- Popover fill: `#2d2d2d`
- Primary text: `#ffffff`; muted text: 50–64% white
- Info fill/text: `#0d273f` / `#83c3ff`
- Primary action: white with `#0d0d0d` text
- Stop action: `#f0aa78` with `#17110d` text

Brand navy and blue remain `#1F3864` and `#2E75B6` at source, but compact dark
icons and waveform accents blend them toward the foreground as the approved
HTML does. Do not replace these charcoal surfaces with the older blue-cast
`#1f2228` / `#272b32` palette.

## Layout system

Every screen sits in an app shell:

- **Integrated title bar** (40px): the Electron Window Controls Overlay places
  native Windows minimize, maximize/restore, and close controls in the same bar
  as the app chrome. App/home sits on the left, compact recording or processing
  status in the centre, and Settings plus the user avatar immediately before
  the reserved native-controls area on the right. Empty regions remain
  draggable; app controls are explicitly non-draggable. The native overlay
  colour and symbols must follow the resolved light or dark theme.
- **No sidebar**: primary navigation is intentionally absent from the compact
  audio-first workflow.
- **Content area**: max content width 620px with 16px outer padding. The
  Electron window measures the active screen and adjusts its content height,
  with a 320px minimum and 680px cap. Longer views scroll within the window.
- **Card**: translucent `bg-primary`, no default border or shadow, 20px radius,
  and 12px padding. Use 1px separators inside cards where rows need structure.
- **Controls**: base text fields and action buttons are 28px high with a 12px
  radius. The custom select trigger is 36px high with an 8px radius; its menu
  chooses above or below based on available space and scrolls long real-device
  lists instead of clipping.
- **Responsive behaviour**: at 560px, meter and settings rows stack and selects
  become full width. At 400px, the brand/status detail is hidden and content
  padding tightens to 12px. The Electron window can be resized down to 400px
  so both breakpoints are reachable.

## Component inventory

- `AppShell` — compact top bar + centered content slot; no navigation rail
- `TopBar` — integrated draggable title bar; brand/home affordance; quiet
  processing detail or compact live recording timer; Settings and user avatar;
  reserved space for native Windows controls
- `CaptureCard` — “Manual capture” eyebrow, meeting title, optional attendee
  disclosure and chips, then equal-width Upload recording and Start recording
  actions
- `RecordingCard` — meeting title, elapsed timer, waveform, microphone/system
  audio meters, scheduled end plus remaining time, and equal-width Pause,
  Extend 10 min, and Stop recording actions
- `SelectMenu` — app-styled keyboard-accessible menu with selected-state check,
  click-away/Escape handling, truncation, collision-aware placement, and
  bounded scrolling
- `SettingsScreen` — compact Audio capture page plus a secondary App and
  advanced settings page for appearance, startup, updates, support, and account
- `ReportProblemModal` — opaque compact modal with form, disabled/send/loading,
  error, and success states

## Screen inventory

The approved compact HTML package is the visual reference for the primary
renderer workflow below. Legacy review components remain in the repository for
backend-driven states but are not primary navigation destinations.

| Screen | Reference | Notes |
|---|---|---|
| Home | approved compact HTML | manual meeting title, optional attendees, upload and start actions |
| Recording in progress | approved compact HTML | live status/timer, audio meters, scheduled end, Pause, Extend 10 min, Stop |
| Settings | approved compact HTML | microphone and system-audio readiness |
| App and advanced settings | approved compact HTML | theme, startup, updates, support, account |
| Report a problem | approved compact HTML | opaque modal with form and success state |
| Login / authorisation | production flow | unchanged by the compact renderer redesign |
| Voiceprint enrollment | production flow | unchanged; three-clip consent flow |

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

## Local UI preview

Run `npm run dev:ui` to open a development-only Electron preview when work authentication is unavailable. It uses the real renderer components with sample data and has the same chrome as the product—there is no preview toolbar in the app.

- It is enabled only when Electron Vite runs in `ui-preview` mode.
- It does not bypass or modify the normal Microsoft authentication flow.
- Preview capture, startup, update, report, upload, and sign-out actions are simulated locally and do not call the backend or change Windows startup settings.
- Navigate normally with the brand and Settings button, or use `Ctrl+1` for Home, `Ctrl+2` for Recording, and `Ctrl+3` for Settings.
- The product and preview windows use the same 620px content width, integrated native title bar, and automatic height fitting for the active screen. This removes unused vertical space on compact views while keeping long views scrollable.
- Use `npm run dev` for the normal authenticated application.
