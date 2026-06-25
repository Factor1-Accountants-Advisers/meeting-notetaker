import { ipcMain } from 'electron'
import { getCurrentUser } from './auth-session'

// All backend traffic goes through the main process: the renderer never holds
// credentials or talks to the network directly (thin-client rule). Entra ID
// tokens will be attached here once auth lands.
const API_BASE = process.env.MN_API_BASE ?? 'http://127.0.0.1:8787'

interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

export function registerApiProxyIpc(): void {
  ipcMain.handle('api:request', async (_event, req: ApiRequest) => {
    try {
      const headers: Record<string, string> = { 'X-MN-User': getCurrentUser() }
      if (req.body !== undefined) headers['content-type'] = 'application/json'
      const res = await fetch(`${API_BASE}${req.path}`, {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined
      })
      const text = await res.text()
      return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null }
    } catch {
      // Backend not running / unreachable — renderer falls back to sample data.
      return { ok: false, status: 0, body: null }
    }
  })
}
