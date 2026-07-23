import { ipcMain } from 'electron'
import {
  getCurrentUser,
  getCurrentUserEmail,
  getCurrentUserOid,
  getGraphAccessToken,
  getStorageApiAccessToken
} from './auth-session'
import { GRAPH_EMAIL_SCOPES, GRAPH_SHAREPOINT_SCOPES } from './auth-msal'
import {
  isStorageRoute,
  loggablePath,
  timeoutMsFor,
  type ApiRequest
} from './api-request-policy'
import { logger } from './logger'
import { isStorageApiEnabled, storageIdentityHeaders } from './storage-api-identity'

// All backend traffic goes through the main process: the renderer never holds
// credentials or talks to the network directly (thin-client rule). Entra ID
// tokens will be attached here once auth lands.
const API_BASE = process.env.MN_API_BASE ?? 'http://127.0.0.1:8787'

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

      // IN-476: email remains the local person key; Entra oid is the central
      // Storage API key. The renderer sees neither the token nor these headers.
      if (isStorageRoute(req)) {
        const scope = process.env.MN_STORAGE_API_SCOPE
        const token =
          scope && isStorageApiEnabled(process.env)
            ? await getStorageApiAccessToken(scope)
            : null
        Object.assign(
          headers,
          storageIdentityHeaders({
            email: getCurrentUserEmail(),
            oid: getCurrentUserOid(),
            accessToken: token ?? undefined
          })
        )
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
