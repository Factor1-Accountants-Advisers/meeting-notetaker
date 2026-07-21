import { ipcMain } from 'electron'
import { getCurrentUser, getCurrentUserEmail, getGraphAccessToken, getStorageApiAccessToken } from './auth-session'
import { GRAPH_EMAIL_SCOPES, GRAPH_SHAREPOINT_SCOPES } from './auth-msal'
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

      // Inject Graph token for email endpoints (IN-93: delegated Mail.Send) and
      // SharePoint delivery (Phase 4: delegated Files.ReadWrite).
      if (req.path.includes('/email') && req.method === 'POST') {
        const token = await getGraphAccessToken(GRAPH_EMAIL_SCOPES)
        if (token) headers['X-MN-Graph-Token'] = token
      }
      if (req.path.includes('/sharepoint') && req.method === 'POST') {
        const token = await getGraphAccessToken(GRAPH_SHAREPOINT_SCOPES)
        if (token) headers['X-MN-Graph-Token'] = token
      }

      // IN-379: identity + delegated Storage API token for enrolment routes.
      // Email identifies "me" server-side (X-MN-User carries the display name).
      // Boundary check: `req.path.includes('/enroll')` must not also match the
      // POST /people/{id}/flag-reenrollment route. It doesn't — "flag-reenrollment"
      // has no literal "/enroll" substring (the only slashes in that path precede
      // "people", the id, and "flag-reenrollment"; "enroll" there is embedded in
      // "re-enroll-ment" preceded by "re", not "/"). Confirmed against the full
      // /people route list (backend/app/routers/people.py): "", "/me",
      // "/me/enrolment-status", "/{id}/enroll", "/{id}/flag-reenrollment" — only
      // the enroll route itself contains "/enroll".
      const storageRoute =
        (req.path.includes('/enroll') && req.method === 'POST') ||
        req.path.includes('/people/me/enrolment-status')
      if (storageRoute) {
        const scope = process.env.MN_STORAGE_API_SCOPE
        if (scope) {
          // Acquire first: silent MSAL acquisition also refreshes the cached
          // account email, so a cold start still sends X-MN-User-Email.
          const token = await getStorageApiAccessToken(scope)
          if (token) headers['X-MN-Storage-Token'] = token
        }
        const email = getCurrentUserEmail()
        if (email) headers['X-MN-User-Email'] = email
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
