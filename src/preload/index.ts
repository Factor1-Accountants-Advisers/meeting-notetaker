import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface ApiResponse<T = unknown> {
  ok: boolean
  status: number // 0 = backend unreachable
  body: T | null
}

export interface AutoStartRequest {
  eventId: string
  idempotencyKey: string
  startTimeUtc: string
  endTimeUtc: string
  source: 'auto' | 'manual'
  metadata?: GraphMeetingMetadata
}

export interface GraphMeetingMetadata {
  title?: string
  attendees: { name?: string; email?: string; response?: string }[]
  meetingId: string
  onlineMeetingId?: string
  joinWebUrl?: string
  organizerEmail?: string
}

export interface AutoStopRequest {
  eventId: string
  idempotencyKey: string
}

// Single funnel to the FastAPI backend via the main process. The renderer
// never touches the network or any credentials directly.
const api = {
  request: <T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<ApiResponse<T>> => ipcRenderer.invoke('api:request', { method, path, body }),

  /** Persist a finished capture under userData/recordings. */
  saveRecording: (name: string, data: ArrayBuffer): Promise<{ path: string }> =>
    ipcRenderer.invoke('recording:save', name, data),

  /** Renderer diagnostics mirrored into the main log for live desktop debugging. */
  debugLog: (message: string, details?: unknown): void =>
    ipcRenderer.send('renderer:debug-log', message, details),

  /** Audit actor for backend calls; cleared on sign-out. */
  setUser: (name: string): void => ipcRenderer.send('auth:set-user', name),

  /** Manual update check (Settings). */
  checkUpdates: (): Promise<{
    state: 'dev' | 'checking' | 'up-to-date' | 'available' | 'downloaded' | 'error'
    version?: string
    message?: string
  }> => ipcRenderer.invoke('updates:check'),

  /** Windows startup registration. Packaged Windows app defaults this on. */
  getAutoLaunch: (): Promise<{
    supported: boolean
    enabled: boolean
    managedByDefault: boolean
    reason?: string
  }> => ipcRenderer.invoke('startup:get-auto-launch'),

  setAutoLaunch: (enabled: boolean): Promise<{
    supported: boolean
    enabled: boolean
    managedByDefault: boolean
    reason?: string
  }> => ipcRenderer.invoke('startup:set-auto-launch', enabled),

  /** Interactive Microsoft sign-in via MSAL. Returns user info or null if failed/not configured. */
  signIn: (): Promise<{ ok: boolean; name?: string; email?: string; error?: string }> =>
    ipcRenderer.invoke('auth:sign-in'),

  /** Listen for main→renderer auto-start recording commands. Returns unsubscribe function. */
  onAutoStartRequest: (callback: (data: AutoStartRequest) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: AutoStartRequest) => callback(data)
    ipcRenderer.on('recording:auto-start-request', handler)
    return () => {
      ipcRenderer.removeListener('recording:auto-start-request', handler)
    }
  },

  /** Listen for main→renderer auto-stop recording commands. Returns unsubscribe function. */
  onAutoStopRequest: (callback: (data: AutoStopRequest) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: AutoStopRequest) => callback(data)
    ipcRenderer.on('recording:auto-stop-request', handler)
    return () => {
      ipcRenderer.removeListener('recording:auto-stop-request', handler)
    }
  },

  /** Notify main process that the renderer started recording successfully. */
  notifyRecordingStarted: (): void => ipcRenderer.send('recording:started'),

  /** Notify main process that recording stopped. */
  notifyRecordingStopped: (): void => ipcRenderer.send('recording:stopped'),

  /** Notify main process of a recording error. */
  notifyRecordingError: (message: string): void => ipcRenderer.send('recording:error', message)
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
