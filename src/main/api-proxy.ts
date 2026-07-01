import { ipcMain } from 'electron'
import { getCurrentUser, getGraphAccessToken } from './auth-session'
import { GRAPH_EMAIL_SCOPES } from './auth-msal'
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

function timeoutMsFor(req: ApiRequest): number {
  const path = loggablePath(req.path)
  if (req.method === 'POST' && path.endsWith('/audio')) return 120_000
  if (req.method === 'POST' && path.endsWith('/email')) return 90_000
  if (req.method === 'POST') return 30_000
  return 15_000
}

function parseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function registerApiProxyIpc(): void {
  ipcMain.handle('api:request', async (_event, req: ApiRequest) => {
    const path = loggablePath(req.path)
    const timeoutMs = timeoutMsFor(req)
    logger().info('[api-proxy] request', { method: req.method, path, timeoutMs })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { 'X-MN-User': getCurrentUser() }
      if (req.body !== undefined) headers['content-type'] = 'application/json'

      // Inject Graph token for email endpoints (IN-93: delegated Mail.Send)
      if (req.path.includes('/email') && req.method === 'POST') {
        const token = await getGraphAccessToken(GRAPH_EMAIL_SCOPES)
        if (token) headers['X-MN-Graph-Token'] = token
      }

      const res = await fetch(`${API_BASE}${req.path}`, {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal
      })
      const text = await res.text()
      if (!res.ok) {
        logger().warn('[api-proxy] backend returned non-ok response', {
          method: req.method,
          path,
          status: res.status
        })
      }
      return { ok: res.ok, status: res.status, body: parseBody(text) }
    } catch (err) {
      const aborted = controller.signal.aborted
      logger().warn('[api-proxy] backend request failed', {
        method: req.method,
        path,
        timeoutMs,
        aborted,
        message: aborted ? `Backend request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err)
      })
      // Backend not running / wedged / unreachable — renderer keeps the local recording and exposes retry.
      return { ok: false, status: aborted ? 408 : 0, body: null }
    } finally {
      clearTimeout(timer)
    }
  })
}
