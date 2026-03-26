# Step 9: Electron Desktop Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows system-tray Electron app that captures WASAPI audio (mic + system loopback), authenticates via Azure AD MSAL, lets the user pick a calendar meeting, and uploads the mixed .wav to the backend API.

**Architecture:** Electron 29 with a strict main/renderer split — all Node.js APIs live in the main process; the renderer popup communicates exclusively through a `contextBridge` preload script. FFmpeg (via `ffmpeg-static` + `fluent-ffmpeg`) handles WASAPI dual-stream capture and amix in the main process. MSAL token cache is encrypted on disk via `keytar`. `electron-builder` packages to an MSI and `electron-updater` handles auto-updates.

**Tech Stack:** Electron 29, TypeScript 5, `@azure/msal-node` 2.x, `fluent-ffmpeg` + `ffmpeg-static`, `axios`, `form-data`, `electron-updater`, `electron-builder` 24, Jest 29 + `ts-jest`

---

## Scope Check

Step 9 is a single self-contained deliverable (the desktop agent). No split required.

---

## File Structure

```
desktop/
├── src/
│   ├── main/
│   │   ├── index.ts          # Electron app entry: lifecycle, tray, auto-updater
│   │   ├── tray.ts           # Tray icon construction, context menu, icon swap idle/recording
│   │   ├── recorder.ts       # FFmpeg WASAPI loopback + mic capture, amix to .wav
│   │   ├── uploader.ts       # multipart POST /api/meetings/upload with Bearer token
│   │   ├── auth.ts           # MSAL PublicClientApplication, token acquire + disk cache
│   │   ├── graph.ts          # Microsoft Graph /me/calendarView fetch, returns CalendarEvent[]
│   │   └── ipc.ts            # ipcMain handler registration (auth, graph, record, upload)
│   └── renderer/
│       └── meeting-selector/
│           ├── preload.ts    # contextBridge: exposes getCalendar, selectMeeting to renderer
│           ├── index.html    # Shell HTML for meeting-selector popup window
│           └── app.ts        # DOM logic: renders meeting list, fires selectMeeting on click
├── assets/
│   ├── icon-idle.png         # 16x16 grey tray icon
│   └── icon-recording.png   # 16x16 green tray icon
├── tests/
│   ├── auth.test.ts
│   ├── graph.test.ts
│   ├── recorder.test.ts
│   └── uploader.test.ts
├── package.json
├── tsconfig.main.json
├── tsconfig.renderer.json
├── electron-builder.yml
└── jest.config.js
```

**Responsibility boundaries:**
- `auth.ts` — only MSAL. Returns `string` (access token). No Electron imports.
- `graph.ts` — only Graph API. Accepts a token string. Returns typed `CalendarEvent[]`. No Electron imports.
- `recorder.ts` — only FFmpeg child-process management. No Electron imports.
- `uploader.ts` — only HTTP upload. Returns `{ meeting_id, status }`. No Electron imports.
- `ipc.ts` — wires ipcMain channels to the above four modules.
- `tray.ts` — constructs `Tray` + `Menu`. Coordinates recording/upload flow.
- `index.ts` — Electron lifecycle only.

The four pure-business-logic modules contain no Electron imports — making them unit-testable without an Electron runtime.

---

## Task 1: Package Scaffold

**Files:**
- Modify: `desktop/package.json`
- Create: `desktop/jest.config.js`
- Create: `desktop/tests/__mocks__/electron.ts`
- Create: `desktop/electron-builder.yml`

- [ ] **Step 1: Install dependencies**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm install fluent-ffmpeg ffmpeg-static keytar dotenv
npm install --save-dev @types/fluent-ffmpeg @types/keytar @types/node
```

- [ ] **Step 2: Create `desktop/jest.config.js`**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron.ts',
  },
  globals: {
    'ts-jest': { tsconfig: 'tsconfig.main.json' },
  },
};
```

- [ ] **Step 3: Create `desktop/tests/__mocks__/electron.ts`**

```ts
export const app = { getPath: jest.fn(() => '/tmp/test'), isPackaged: false };
export const ipcMain = { handle: jest.fn(), on: jest.fn() };
export const BrowserWindow = jest.fn();
export const Tray = jest.fn();
export const Menu = { buildFromTemplate: jest.fn() };
export const nativeImage = { createFromPath: jest.fn() };
export const shell = { openExternal: jest.fn() };
export default { app, ipcMain, BrowserWindow, Tray, Menu, nativeImage, shell };
```

- [ ] **Step 4: Create `desktop/electron-builder.yml`**

```yaml
appId: com.yourfirm.meetingnotetaker
productName: Meeting Note-Taker
directories:
  output: release
files:
  - dist/**/*
  - assets/**/*
  - node_modules/**/*
  - package.json
win:
  target:
    - target: msi
      arch: [x64]
  icon: assets/icon-idle.png
msi:
  oneClick: false
  perMachine: true
publish:
  provider: generic
  url: https://YOUR_UPDATE_SERVER/releases/
```

Replace `url` with actual update server URL before distributing.

- [ ] **Step 5: Run Jest — confirm zero tests, no crash**

```bash
npx jest --passWithNoTests
```

Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add desktop/
git commit -m "chore(desktop): scaffold jest, electron mock, electron-builder config"
```

---

## Task 2: `auth.ts` — MSAL Token Acquisition

**Files:**
- Create: `desktop/src/main/auth.ts`
- Create: `desktop/tests/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `desktop/tests/auth.test.ts`:

```ts
import { acquireToken, clearTokenCache } from '../src/main/auth';

const mockAcquireTokenSilent = jest.fn();
const mockAcquireTokenByDeviceCode = jest.fn();
const mockGetAllAccounts = jest.fn().mockResolvedValue([{ homeAccountId: 'acc1' }]);

jest.mock('@azure/msal-node', () => ({
  PublicClientApplication: jest.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenByDeviceCode: mockAcquireTokenByDeviceCode,
    getTokenCache: jest.fn().mockReturnValue({
      serialize: jest.fn().mockResolvedValue('serialized'),
      deserialize: jest.fn().mockResolvedValue(undefined),
      getAllAccounts: mockGetAllAccounts,
    }),
  })),
  LogLevel: { Warning: 2 },
}));

jest.mock('keytar', () => ({
  getPassword: jest.fn().mockResolvedValue(null),
  setPassword: jest.fn().mockResolvedValue(undefined),
  deletePassword: jest.fn().mockResolvedValue(undefined),
}));

process.env.AZURE_AD_CLIENT_ID = 'test-client-id';
process.env.AZURE_AD_TENANT_ID = 'test-tenant-id';

describe('auth.acquireToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns access token on silent success', async () => {
    mockAcquireTokenSilent.mockResolvedValueOnce({ accessToken: 'token-abc' });
    expect(await acquireToken()).toBe('token-abc');
    expect(mockAcquireTokenByDeviceCode).not.toHaveBeenCalled();
  });

  it('falls back to device code when silent throws', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('no_account'));
    mockAcquireTokenByDeviceCode.mockImplementation(async ({ deviceCodeCallback }: any) => {
      deviceCodeCallback({ message: 'Go to https://microsoft.com/devicelogin' });
      return { accessToken: 'token-device' };
    });
    expect(await acquireToken()).toBe('token-device');
  });

  it('throws when device code also fails', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('silent_fail'));
    mockAcquireTokenByDeviceCode.mockRejectedValueOnce(new Error('device_fail'));
    await expect(acquireToken()).rejects.toThrow('device_fail');
  });
});
```

- [ ] **Step 2: Run — confirm fail**

```bash
npx jest tests/auth.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '../src/main/auth'`

- [ ] **Step 3: Implement `desktop/src/main/auth.ts`**

```ts
import { PublicClientApplication, AccountInfo, LogLevel } from '@azure/msal-node';
import * as keytar from 'keytar';

const SERVICE = 'MeetingNoteTaker';
const ACCOUNT = 'msal-cache';
const SCOPES = [
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
];

function buildPca(): PublicClientApplication {
  const clientId = process.env.AZURE_AD_CLIENT_ID;
  const tenantId = process.env.AZURE_AD_TENANT_ID;
  if (!clientId || !tenantId) throw new Error('AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID must be set');
  return new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
    system: {
      loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false, logLevel: LogLevel.Warning },
    },
  });
}

let _pca: PublicClientApplication | null = null;
function getPca(): PublicClientApplication {
  if (!_pca) _pca = buildPca();
  return _pca;
}

async function loadCache(pca: PublicClientApplication): Promise<void> {
  const data = await keytar.getPassword(SERVICE, ACCOUNT);
  if (data) await pca.getTokenCache().deserialize(data);
}

async function saveCache(pca: PublicClientApplication): Promise<void> {
  await keytar.setPassword(SERVICE, ACCOUNT, await pca.getTokenCache().serialize());
}

export async function acquireToken(): Promise<string> {
  const pca = getPca();
  await loadCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0] as AccountInfo, scopes: SCOPES });
      if (result?.accessToken) { await saveCache(pca); return result.accessToken; }
    } catch { /* fall through */ }
  }

  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (r) => console.log(r.message),
  });
  if (!result?.accessToken) throw new Error('Token acquisition failed');
  await saveCache(pca);
  return result.accessToken;
}

export async function clearTokenCache(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT);
  _pca = null;
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx jest tests/auth.test.ts --no-coverage
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/auth.ts desktop/tests/auth.test.ts
git commit -m "feat(desktop): add MSAL auth module with silent + device-code fallback"
```

---

## Task 3: `graph.ts` — Microsoft Graph Calendar Fetch

**Files:**
- Create: `desktop/src/main/graph.ts`
- Create: `desktop/tests/graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `desktop/tests/graph.test.ts`:

```ts
import { getUpcomingMeetings, CalendarEvent } from '../src/main/graph';
jest.mock('axios');
import axios from 'axios';
const mockGet = axios.get as jest.MockedFunction<typeof axios.get>;

describe('graph.getUpcomingMeetings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns mapped CalendarEvent array', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        value: [{
          id: 'evt1', subject: 'Sprint Review',
          start: { dateTime: '2026-03-20T09:00:00' },
          end: { dateTime: '2026-03-20T10:00:00' },
          attendees: [{ emailAddress: { name: 'Alice', address: 'alice@firm.com' } }],
        }],
      },
    });
    const events = await getUpcomingMeetings('mock-token');
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/me/calendarView'),
      expect.objectContaining({ headers: { Authorization: 'Bearer mock-token' } })
    );
    expect(events[0]).toMatchObject<CalendarEvent>({
      id: 'evt1', subject: 'Sprint Review',
      start: '2026-03-20T09:00:00', end: '2026-03-20T10:00:00',
      attendees: [{ name: 'Alice', email: 'alice@firm.com' }],
    });
  });

  it('returns empty array when no events', async () => {
    mockGet.mockResolvedValueOnce({ data: { value: [] } });
    expect(await getUpcomingMeetings('t')).toEqual([]);
  });

  it('throws on network error', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network Error'));
    await expect(getUpcomingMeetings('t')).rejects.toThrow('Network Error');
  });
});
```

- [ ] **Step 2: Run — confirm fail**

```bash
npx jest tests/graph.test.ts --no-coverage
```

- [ ] **Step 3: Implement `desktop/src/main/graph.ts`**

```ts
import axios from 'axios';

export interface CalendarAttendee { name: string; email: string; }
export interface CalendarEvent {
  id: string; subject: string; start: string; end: string;
  attendees: CalendarAttendee[];
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export async function getUpcomingMeetings(accessToken: string): Promise<CalendarEvent[]> {
  const now = new Date();
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: new Date(now.getTime() + 8 * 3600000).toISOString(),
    $select: 'id,subject,start,end,attendees',
    $top: '20',
    $orderby: 'start/dateTime asc',
  });
  const response = await axios.get(`${GRAPH_BASE}/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.data.value as any[]).map((evt) => ({
    id: evt.id as string,
    subject: evt.subject as string,
    start: evt.start.dateTime as string,
    end: evt.end.dateTime as string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attendees: (evt.attendees ?? []).map((a: any) => ({
      name: a.emailAddress.name as string,
      email: a.emailAddress.address as string,
    })),
  }));
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx jest tests/graph.test.ts --no-coverage
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/graph.ts desktop/tests/graph.test.ts
git commit -m "feat(desktop): add Graph API calendar fetch"
```

---

## Task 4: `recorder.ts` — FFmpeg WASAPI Dual-Stream Capture

**Files:**
- Create: `desktop/src/main/recorder.ts`
- Create: `desktop/tests/recorder.test.ts`

FFmpeg command (reference):
```
ffmpeg -f dshow -i "audio=Mic" -f dshow -i "audio=Loopback"
       -filter_complex amix=inputs=2:duration=longest
       -ar 16000 -ac 1 -c:a pcm_s16le -y output.wav
```

- [ ] **Step 1: Write the failing test**

Create `desktop/tests/recorder.test.ts`:

```ts
import { startRecording, stopRecording } from '../src/main/recorder';

const mockInput = jest.fn().mockReturnThis();
const mockInputOptions = jest.fn().mockReturnThis();
const mockComplexFilter = jest.fn().mockReturnThis();
const mockAudioCodec = jest.fn().mockReturnThis();
const mockAudioFrequency = jest.fn().mockReturnThis();
const mockAudioChannels = jest.fn().mockReturnThis();
const mockOutputOptions = jest.fn().mockReturnThis();
const mockSave = jest.fn().mockReturnThis();
const mockKill = jest.fn();
const mockOn = jest.fn().mockReturnThis();

const mockFfmpegInstance = {
  input: mockInput, inputOptions: mockInputOptions,
  complexFilter: mockComplexFilter, audioCodec: mockAudioCodec,
  audioFrequency: mockAudioFrequency, audioChannels: mockAudioChannels,
  outputOptions: mockOutputOptions, save: mockSave,
  kill: mockKill, on: mockOn,
};

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn().mockReturnValue(mockFfmpegInstance);
  (fn as any).setFfmpegPath = jest.fn();
  return fn;
});
jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg');

describe('recorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    try { stopRecording(); } catch { /* already stopped */ }
  });

  it('calls ffmpeg with two dshow inputs and amix filter', () => {
    startRecording({ micName: 'Mic', loopbackName: 'Loop', outputPath: 'out.wav' });
    expect(mockInput).toHaveBeenCalledWith('audio=Mic');
    expect(mockInput).toHaveBeenCalledWith('audio=Loop');
    expect(mockComplexFilter).toHaveBeenCalledWith(expect.stringContaining('amix=inputs=2'));
    expect(mockSave).toHaveBeenCalledWith('out.wav');
  });

  it('stopRecording calls kill(SIGINT)', () => {
    startRecording({ micName: 'Mic', loopbackName: 'Loop', outputPath: 'out.wav' });
    stopRecording();
    expect(mockKill).toHaveBeenCalledWith('SIGINT');
  });

  it('stopRecording is a no-op when not recording', () => {
    expect(() => stopRecording()).not.toThrow();
    expect(mockKill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — confirm fail**

```bash
npx jest tests/recorder.test.ts --no-coverage
```

- [ ] **Step 3: Implement `desktop/src/main/recorder.ts`**

```ts
import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export interface RecordingOptions {
  micName: string;
  loopbackName: string;
  outputPath: string;
}

let activeProcess: FfmpegCommand | null = null;

export function startRecording(options: RecordingOptions): void {
  if (activeProcess) throw new Error('Already recording. Call stopRecording() first.');

  activeProcess = ffmpeg()
    .input(`audio=${options.micName}`)
    .inputOptions(['-f', 'dshow'])
    .input(`audio=${options.loopbackName}`)
    .inputOptions(['-f', 'dshow'])
    .complexFilter('amix=inputs=2:duration=longest:dropout_transition=0')
    .audioFrequency(16000)
    .audioChannels(1)
    .audioCodec('pcm_s16le')
    .outputOptions(['-y'])
    .on('start', (cmd) => console.log('[recorder] started:', cmd))
    .on('error', (err) => {
      if (!err.message.includes('SIGINT')) console.error('[recorder] error:', err.message);
      activeProcess = null;
    })
    .on('end', () => { activeProcess = null; })
    .save(options.outputPath);
}

export function stopRecording(): void {
  if (!activeProcess) return;
  activeProcess.kill('SIGINT');
  activeProcess = null;
}

export function isRecording(): boolean {
  return activeProcess !== null;
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx jest tests/recorder.test.ts --no-coverage
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/recorder.ts desktop/tests/recorder.test.ts
git commit -m "feat(desktop): add FFmpeg WASAPI dual-stream recorder"
```

---

## Task 5: `uploader.ts` — Multipart Upload to Backend

**Files:**
- Create: `desktop/src/main/uploader.ts`
- Create: `desktop/tests/uploader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `desktop/tests/uploader.test.ts`:

```ts
import { uploadRecording, UploadOptions } from '../src/main/uploader';
jest.mock('axios');
import axios from 'axios';
const mockPost = axios.post as jest.MockedFunction<typeof axios.post>;

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn().mockReturnValue('mock-stream'),
}));

const baseOptions: UploadOptions = {
  filePath: 'C:/tmp/meeting.wav',
  accessToken: 'test-token',
  backendUrl: 'http://localhost:8000',
  metadata: {
    meeting_title: 'Sprint Review',
    attendees: [{ name: 'Alice', email: 'alice@firm.com' }],
    scheduled_time: '2026-03-20T09:00:00Z',
  },
};

describe('uploader.uploadRecording', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts to /api/meetings/upload with Bearer token', async () => {
    mockPost.mockResolvedValueOnce({ data: { meeting_id: 42, status: 'processing' } });
    const result = await uploadRecording(baseOptions);
    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:8000/api/meetings/upload',
      expect.any(Object),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) })
    );
    expect(result).toEqual({ meeting_id: 42, status: 'processing' });
  });

  it('throws on HTTP error', async () => {
    mockPost.mockRejectedValueOnce(new Error('Request failed with status code 401'));
    await expect(uploadRecording(baseOptions)).rejects.toThrow('401');
  });
});
```

- [ ] **Step 2: Run — confirm fail**

```bash
npx jest tests/uploader.test.ts --no-coverage
```

- [ ] **Step 3: Implement `desktop/src/main/uploader.ts`**

```ts
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

export interface AttendeeMetadata { name: string; email?: string; }
export interface MeetingMetadata {
  meeting_title: string;
  attendees: AttendeeMetadata[];
  scheduled_time?: string;
}
export interface UploadOptions {
  filePath: string;
  accessToken: string;
  backendUrl: string;
  metadata: MeetingMetadata;
}
export interface UploadResult { meeting_id: number; status: string; }

export async function uploadRecording(options: UploadOptions): Promise<UploadResult> {
  const { filePath, accessToken, backendUrl, metadata } = options;
  const form = new FormData();
  form.append('audio_file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'audio/wav',
  });
  form.append('metadata', JSON.stringify(metadata));

  const response = await axios.post<UploadResult>(
    `${backendUrl}/api/meetings/upload`,
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` },
      maxBodyLength: 600 * 1024 * 1024,
      maxContentLength: 600 * 1024 * 1024,
    }
  );
  return response.data;
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npx jest tests/uploader.test.ts --no-coverage
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/uploader.ts desktop/tests/uploader.test.ts
git commit -m "feat(desktop): add multipart uploader for backend API"
```

---

## Task 6: Full Test Suite Green

- [ ] **Step 1: Run all tests**

```bash
cd C:/Projects/meeting-notetaker/desktop
npx jest --no-coverage
```

Expected: All 11 tests pass across 4 suites.

- [ ] **Step 2: Commit fixes if needed**

```bash
git add -p && git commit -m "fix(desktop): cross-module test interference"
```

---

## Task 7: `ipc.ts` — IPC Channel Registration

**Files:**
- Create: `desktop/src/main/ipc.ts`

- [ ] **Step 1: Create `desktop/src/main/ipc.ts`**

```ts
import { ipcMain, BrowserWindow, shell } from 'electron';
import { acquireToken, clearTokenCache } from './auth';
import { getUpcomingMeetings, CalendarEvent } from './graph';
import { startRecording, stopRecording, isRecording, RecordingOptions } from './recorder';
import { uploadRecording, MeetingMetadata, UploadResult } from './uploader';
import { setPendingMeeting } from './tray';

export function registerIpcHandlers(): void {
  ipcMain.handle('auth:get-token', (): Promise<string> => acquireToken());
  ipcMain.handle('auth:sign-out', (): Promise<void> => clearTokenCache());

  ipcMain.handle('graph:get-calendar', async (): Promise<CalendarEvent[]> => {
    const token = await acquireToken();
    return getUpcomingMeetings(token);
  });

  ipcMain.handle('recorder:start', (_e, opts: RecordingOptions): void => startRecording(opts));
  ipcMain.handle('recorder:stop', (): void => stopRecording());
  ipcMain.handle('recorder:is-recording', (): boolean => isRecording());

  ipcMain.handle(
    'uploader:upload',
    async (_e, args: { recordingOptions: RecordingOptions; metadata: MeetingMetadata; backendUrl: string }): Promise<UploadResult> => {
      const token = await acquireToken();
      return uploadRecording({ filePath: args.recordingOptions.outputPath, accessToken: token, backendUrl: args.backendUrl, metadata: args.metadata });
    }
  );

  ipcMain.handle('shell:open-web-app', (_e, url: string): Promise<void> => shell.openExternal(url));

  ipcMain.handle('meeting-selector:select', (_e, event: CalendarEvent): void => {
    setPendingMeeting(event.subject, event.attendees, event.start);
    BrowserWindow.fromWebContents(_e.sender)?.close();
  });

  ipcMain.on('meeting-selector:close', (e): void => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/main/ipc.ts
git commit -m "feat(desktop): add ipcMain channel registration"
```

---

## Task 8: `tray.ts` — System Tray Icon and Menu

**Files:**
- Create: `desktop/src/main/tray.ts`
- Create: `desktop/assets/icon-idle.png`
- Create: `desktop/assets/icon-recording.png`

- [ ] **Step 1: Create placeholder tray icons**

In PowerShell (if ImageMagick installed):
```powershell
magick -size 16x16 xc:#888888 C:\Projects\meeting-notetaker\desktop\assets\icon-idle.png
magick -size 16x16 xc:#22c55e C:\Projects\meeting-notetaker\desktop\assets\icon-recording.png
```

Otherwise place any valid 16x16 PNGs. Replace with proper icons before release.

- [ ] **Step 2: Create `desktop/src/main/tray.ts`**

```ts
import { Tray, Menu, app, nativeImage, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { startRecording, stopRecording, isRecording } from './recorder';
import { acquireToken } from './auth';
import { uploadRecording, AttendeeMetadata, MeetingMetadata } from './uploader';

const IDLE_ICON = path.join(__dirname, '../../assets/icon-idle.png');
const RECORDING_ICON = path.join(__dirname, '../../assets/icon-recording.png');

let tray: Tray | null = null;
let meetingSelectorWindow: BrowserWindow | null = null;

let _backendUrl = 'http://localhost:8000';
let _webAppUrl = 'http://localhost:3000';
let _recordingOutputDir = '';
let _micName = '';
let _loopbackName = '';
let _currentOutputPath = '';

let _pendingTitle = '';
let _pendingAttendees: AttendeeMetadata[] = [];
let _pendingScheduledTime: string | undefined;

export interface TrayConfig {
  backendUrl: string;
  webAppUrl: string;
  recordingOutputDir: string;
  micName: string;
  loopbackName: string;
}

export function setPendingMeeting(title: string, attendees: AttendeeMetadata[], scheduledTime?: string): void {
  _pendingTitle = title;
  _pendingAttendees = attendees;
  _pendingScheduledTime = scheduledTime;
}

export function createTray(config: TrayConfig): Tray {
  _backendUrl = config.backendUrl;
  _webAppUrl = config.webAppUrl;
  _recordingOutputDir = config.recordingOutputDir;
  _micName = config.micName;
  _loopbackName = config.loopbackName;

  tray = new Tray(nativeImage.createFromPath(IDLE_ICON));
  tray.setToolTip('Meeting Note-Taker');
  tray.on('click', openMeetingSelector);
  rebuildMenu();
  return tray;
}

function rebuildMenu(): void {
  if (!tray) return;
  const recording = isRecording();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Start Recording', enabled: !recording, click: handleStartRecording },
    { label: 'Stop Recording', enabled: recording, click: handleStopRecording },
    { type: 'separator' },
    { label: 'Select Meeting...', click: openMeetingSelector },
    { type: 'separator' },
    { label: 'Open Web App', click: () => shell.openExternal(_webAppUrl) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function handleStartRecording(): void {
  _currentOutputPath = path.join(_recordingOutputDir, `meeting-${Date.now()}.wav`);
  startRecording({ micName: _micName, loopbackName: _loopbackName, outputPath: _currentOutputPath });
  tray?.setImage(nativeImage.createFromPath(RECORDING_ICON));
  tray?.setToolTip('Meeting Note-Taker — Recording...');
  rebuildMenu();
}

async function handleStopRecording(): Promise<void> {
  stopRecording();
  tray?.setImage(nativeImage.createFromPath(IDLE_ICON));
  tray?.setToolTip('Meeting Note-Taker — Uploading...');
  rebuildMenu();

  try {
    const token = await acquireToken();
    const metadata: MeetingMetadata = {
      meeting_title: _pendingTitle || `Recording ${new Date().toLocaleString()}`,
      attendees: _pendingAttendees,
      scheduled_time: _pendingScheduledTime,
    };
    await uploadRecording({ filePath: _currentOutputPath, accessToken: token, backendUrl: _backendUrl, metadata });
    tray?.setToolTip('Meeting Note-Taker — Upload complete');
  } catch (err) {
    console.error('[tray] upload failed:', err);
    tray?.setToolTip('Meeting Note-Taker — Upload failed');
  }

  _pendingTitle = '';
  _pendingAttendees = [];
  _pendingScheduledTime = undefined;
  setTimeout(() => { tray?.setToolTip('Meeting Note-Taker'); rebuildMenu(); }, 3000);
}

function openMeetingSelector(): void {
  if (meetingSelectorWindow && !meetingSelectorWindow.isDestroyed()) {
    meetingSelectorWindow.focus();
    return;
  }
  meetingSelectorWindow = new BrowserWindow({
    width: 480, height: 400, resizable: false, alwaysOnTop: true,
    title: 'Select Meeting',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../renderer/meeting-selector/preload.js'),
    },
  });
  meetingSelectorWindow.loadFile(
    path.join(__dirname, '../../src/renderer/meeting-selector/index.html')
  );
  meetingSelectorWindow.on('closed', () => { meetingSelectorWindow = null; });
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/tray.ts desktop/assets/
git commit -m "feat(desktop): add system tray with idle/recording icons and context menu"
```

---

## Task 9: Renderer — Meeting Selector Popup

**Files:**
- Create: `desktop/src/renderer/meeting-selector/preload.ts`
- Create: `desktop/src/renderer/meeting-selector/index.html`
- Create: `desktop/src/renderer/meeting-selector/app.ts`

- [ ] **Step 1: Create `desktop/src/renderer/meeting-selector/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { CalendarEvent } from '../../main/graph';

contextBridge.exposeInMainWorld('meetingSelector', {
  getCalendar: (): Promise<CalendarEvent[]> => ipcRenderer.invoke('graph:get-calendar'),
  selectMeeting: (event: CalendarEvent): Promise<void> => ipcRenderer.invoke('meeting-selector:select', event),
  closeWindow: (): void => ipcRenderer.send('meeting-selector:close'),
});
```

- [ ] **Step 2: Create `desktop/src/renderer/meeting-selector/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Select Meeting</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; }
    h2 { padding: 12px 16px; font-size: 14px; border-bottom: 1px solid #e5e7eb; }
    #loading, #error { padding: 16px; color: #6b7280; }
    #error { color: #dc2626; }
    ul { list-style: none; overflow-y: auto; max-height: 320px; }
    li { padding: 10px 16px; cursor: pointer; border-bottom: 1px solid #f3f4f6; }
    li:hover { background: #f0f9ff; }
    .evt-title { font-weight: 600; margin-bottom: 3px; }
    .evt-meta { font-size: 11px; color: #6b7280; }
    #btn-skip { display: block; padding: 8px 16px; font-size: 12px; color: #6b7280;
                cursor: pointer; text-align: center; border-top: 1px solid #e5e7eb; }
    #btn-skip:hover { background: #f9fafb; }
  </style>
</head>
<body>
  <h2>Select Meeting to Record</h2>
  <div id="loading">Loading your calendar...</div>
  <ul id="meeting-list" hidden></ul>
  <div id="error" hidden></div>
  <div id="btn-skip">Skip — record without meeting info</div>
  <script src="../../../dist/renderer/meeting-selector/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `desktop/src/renderer/meeting-selector/app.ts`**

NOTE: Uses `textContent` and `createElement` only — no `innerHTML` — to avoid XSS.

```ts
import type { CalendarEvent } from '../../main/graph';

declare global {
  interface Window {
    meetingSelector: {
      getCalendar: () => Promise<CalendarEvent[]>;
      selectMeeting: (event: CalendarEvent) => Promise<void>;
      closeWindow: () => void;
    };
  }
}

function buildEventItem(evt: CalendarEvent): HTMLLIElement {
  const li = document.createElement('li');
  const time = new Date(evt.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const names = evt.attendees.map((a) => a.name).join(', ') || 'No attendees';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'evt-title';
  titleDiv.textContent = evt.subject;

  const metaDiv = document.createElement('div');
  metaDiv.className = 'evt-meta';
  metaDiv.textContent = `${time} · ${names}`;

  li.appendChild(titleDiv);
  li.appendChild(metaDiv);
  li.addEventListener('click', () => window.meetingSelector.selectMeeting(evt));
  return li;
}

async function init(): Promise<void> {
  const loadingEl = document.getElementById('loading')!;
  const listEl = document.getElementById('meeting-list')!;
  const errorEl = document.getElementById('error')!;

  document.getElementById('btn-skip')!.addEventListener('click', () =>
    window.meetingSelector.closeWindow()
  );

  try {
    const events = await window.meetingSelector.getCalendar();
    loadingEl.hidden = true;

    if (events.length === 0) {
      errorEl.textContent = 'No upcoming meetings in the next 8 hours.';
      errorEl.hidden = false;
      return;
    }

    for (const evt of events) {
      listEl.appendChild(buildEventItem(evt));
    }
    listEl.hidden = false;
  } catch (err: unknown) {
    loadingEl.hidden = true;
    errorEl.textContent = `Failed to load calendar: ${err instanceof Error ? err.message : String(err)}`;
    errorEl.hidden = false;
  }
}

init();
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src/renderer/
git commit -m "feat(desktop): add meeting-selector popup renderer (XSS-safe DOM construction)"
```

---

## Task 10: `index.ts` — Electron App Entry and Auto-Updater

**Files:**
- Create: `desktop/src/main/index.ts`

- [ ] **Step 1: Create `desktop/src/main/index.ts`**

```ts
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local before any other imports read process.env
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createTray } from './tray';
import { registerIpcHandlers } from './ipc';

if (!app.requestSingleInstanceLock()) app.quit();

app.disableHardwareAcceleration();
app.on('window-all-closed', (e: Event) => e.preventDefault());

app.whenReady().then(() => {
  registerIpcHandlers();
  createTray({
    backendUrl: process.env.BACKEND_URL ?? 'http://localhost:8000',
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:3000',
    recordingOutputDir: app.getPath('temp'),
    micName: process.env.MIC_DEVICE_NAME ?? '',
    loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
  });
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
  }
});
```

- [ ] **Step 2: TypeScript compile check (no emit)**

```bash
cd C:/Projects/meeting-notetaker/desktop
npx tsc -p tsconfig.main.json --noEmit
npx tsc -p tsconfig.renderer.json --noEmit
```

Expected: zero errors in both.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main/index.ts
git commit -m "feat(desktop): add Electron app entry with dotenv + auto-updater"
```

---

## Task 11: Development Smoke Test

- [ ] **Step 1: Find your audio device names (PowerShell)**

```powershell
ffmpeg -list_devices true -f dshow -i dummy 2>&1 | Select-String "audio"
```

Note the exact names. For loopback you need VB-Audio Virtual Cable (free, https://vb-audio.com/Cable/) or similar.

- [ ] **Step 2: Create `desktop/.env.local` (do not commit)**

```env
AZURE_AD_CLIENT_ID=<your-client-id>
AZURE_AD_TENANT_ID=<your-tenant-id>
BACKEND_URL=http://localhost:8000
WEB_APP_URL=http://localhost:3000
MIC_DEVICE_NAME=Microphone Array (Realtek Audio)
LOOPBACK_DEVICE_NAME=CABLE Output (VB-Audio Virtual Cable)
```

- [ ] **Step 3: Build and launch**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm run build && npx electron .
```

Expected: tray icon appears in Windows notification area.

- [ ] **Step 4: Verify tray menu**

Right-click → 5 items present. "Start Recording" enabled. "Stop Recording" disabled.

- [ ] **Step 5: Test recording + upload (backend running)**

```bash
# Start backend
cd C:/Projects/meeting-notetaker && docker-compose up -d
```

- Start Recording → icon turns green
- Wait 10s → Stop Recording → tooltip shows "Uploading..."
- Check: `docker-compose logs backend | grep "POST /api/meetings/upload"`
- Open `http://localhost:3000` → new meeting with status "processing"

- [ ] **Step 6: Commit smoke-test fixes**

```bash
git add -p && git commit -m "fix(desktop): smoke test fixes"
```

---

## Task 12: Package as MSI

- [ ] **Step 1: Build and package**

```bash
cd C:/Projects/meeting-notetaker/desktop
npm run build && npm run dist:win
```

Expected: `release/Meeting Note-Taker-1.0.0.msi`

- [ ] **Step 2: Install and verify**

Double-click MSI → UAC prompt → installs to `C:\Program Files\Meeting Note-Taker\` → tray icon appears → uninstallable via Settings → Apps.

- [ ] **Step 3: Commit**

```bash
git add desktop/electron-builder.yml
git commit -m "chore(desktop): finalize MSI build config"
```

---

## Task 13: Final Verification

- [ ] **Step 1: Full unit test run with coverage**

```bash
cd C:/Projects/meeting-notetaker/desktop
npx jest --coverage
```

Expected: All 11 tests pass.

- [ ] **Step 2: Final commit**

```bash
git add -p
git commit -m "feat(desktop): Step 9 complete — Electron desktop agent with WASAPI, MSAL, MSI"
```

---

## Environment Variables Reference

| Variable | Purpose |
|---|---|
| `AZURE_AD_CLIENT_ID` | MSAL app registration client ID |
| `AZURE_AD_TENANT_ID` | Azure AD tenant ID |
| `BACKEND_URL` | Backend API base URL |
| `WEB_APP_URL` | Web app URL for "Open Web App" menu item |
| `MIC_DEVICE_NAME` | Windows DirectShow microphone device name |
| `LOOPBACK_DEVICE_NAME` | Windows DirectShow loopback device name (requires VB-Audio Cable or similar) |

The Azure AD app registration must have `User.Read` and `Calendars.Read` delegated Graph permissions admin-consented.
