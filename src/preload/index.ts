import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface ApiResponse<T = unknown> {
  ok: boolean
  status: number // 0 = backend unreachable
  body: T | null
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

  /** Audit actor for backend calls; cleared on sign-out. */
  setUser: (name: string): void => ipcRenderer.send('auth:set-user', name),

  /** Manual update check (Settings). */
  checkUpdates: (): Promise<{
    state: 'dev' | 'checking' | 'up-to-date' | 'available' | 'downloaded' | 'error'
    version?: string
    message?: string
  }> => ipcRenderer.invoke('updates:check'),

  /** Interactive Microsoft sign-in via MSAL. Returns user info or null if failed/not configured. */
  signIn: (): Promise<{ ok: boolean; name?: string; email?: string; error?: string }> =>
    ipcRenderer.invoke('auth:sign-in')
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
