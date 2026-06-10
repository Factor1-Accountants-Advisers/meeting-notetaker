# Meeting Notetaker

Internal desktop app for **Factor1 Accountants & Advisers** — records meetings,
transcribes them, identifies speakers, and produces summaries and action items.

See [`CLAUDE.md`](CLAUDE.md) and [`docs/`](docs) for architecture, requirements,
and the design system.

## Stack

- **Desktop**: Electron (thin client) + React + Vite + TypeScript + Tailwind CSS
- **Icons**: lucide-react
- **Backend** (not yet scaffolded): Python + FastAPI — the only component that
  touches the database
- **Cloud**: Azure Blob, PostgreSQL, Key Vault, AI Speech, OpenAI

## Develop

```bash
npm install
npm run dev          # app with hot reload
npm run typecheck    # type-check main/preload + renderer
npm run build        # production build into out/
npm run package      # NSIS installer via electron-builder (Windows)
```

## Source layout

```
src/
  main/      Electron main process (window, lifecycle)
  preload/   context-bridge API surface to the renderer
  renderer/  React app
    src/
      assets/      design-token CSS variables + Tailwind entry
      components/  shell (TopBar, NavRail, AppShell) + UI
      lib/         theme, navigation
      screens/     per-route screens
```
