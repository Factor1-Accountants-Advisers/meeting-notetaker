# Meeting Note-Taker Web UI

This folder contains the Next.js frontend used by the desktop app.

## Preferred Development Workflow

In normal local development, you do not start `web` on its own.
The desktop app starts it for you.

### Terminal 1: Backend

```powershell
cd C:\Projects\meeting-notetaker\backend
uvicorn app.main:app --reload --port 8000
```

### Terminal 2: Desktop + Frontend

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm run dev
```

`desktop/npm run dev` starts the Next.js dev server from `../web` and then launches Electron.

## Running Web Standalone

If you want to run only the web app in a browser:

```bash
npm run dev
```

Open `http://localhost:3000`.

This still expects the backend to be running on `http://localhost:8000`.

## Notes

- Docker is not required for normal frontend development
- The production Action Items redesign lives under `src/app/(protected)/action-items/` and `src/components/action-items/`

Lint:

```bash
npm run lint
```

Tests:

```bash
npm test
```

## Next.js

- [Next.js Documentation](https://nextjs.org/docs)
- [Learn Next.js](https://nextjs.org/learn)
