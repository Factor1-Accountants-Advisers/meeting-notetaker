import { ipcMain } from 'electron'
import { getCurrentUser } from './auth-session'
import { logger } from './logger'

// All backend traffic goes through the main process: the renderer never holds
// credentials or talks to the network directly (thin-client rule). Entra ID
// tokens will be attached here once auth lands.
const API_BASE = process.env.MN_API_BASE ?? 'http://127.0.0.1:8787'

interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

function loggablePath(path: string): string {
  return path.split('?')[0]
}

export function registerApiProxyIpc(): void {
  ipcMain.handle('api:request', async (_event, req: ApiRequest) => {
    const path = loggablePath(req.path)
    try {
      const headers: Record<string, string> = { 'X-MN-User': getCurrentUser() }
      if (req.body !== undefined) headers['content-type'] = 'application/json'
      const res = await fetch(`${API_BASE}${req.path}`, {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined
      })
      const text = await res.text()
      if (!res.ok) {
        logger().warn('[api-proxy] backend returned non-ok response', {
          method: req.method,
          path,
          status: res.status
        })
      }
      return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null }
    } catch (err) {
      logger().warn('[api-proxy] backend request failed', {
        method: req.method,
        path,
        message: err instanceof Error ? err.message : String(err)
      })
      // Backend not running / unreachable — renderer falls back to sample data.
      return { ok: false, status: 0, body: null }
    }
  })
}
