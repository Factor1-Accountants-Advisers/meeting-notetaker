import { get } from 'node:http'

/**
 * Probe a local HTTP health endpoint with a true wall-clock deadline.
 *
 * Electron's main-process fetch has been observed remaining pending even after
 * its AbortController fired. A standalone timer plus request.destroy() makes
 * the supervisor deadline independent of fetch/undici cancellation behavior.
 */
export async function probeHttpHealth(url: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (healthy: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(healthy)
    }

    const request = get(url, (response) => {
      response.resume()
      finish(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300))
    })

    const deadline = setTimeout(() => {
      request.destroy()
      finish(false)
    }, timeoutMs)

    request.once('error', () => finish(false))
  })
}

/**
 * Fetch and parse a health endpoint's JSON body. Null on any failure —
 * timeout, non-2xx, or unparseable body.
 */
export async function fetchHealthJson(
  url: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(value)
    }

    const request = get(url, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        finish(null)
        return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          finish(
            parsed !== null && typeof parsed === 'object'
              ? (parsed as Record<string, unknown>)
              : null
          )
        } catch {
          finish(null)
        }
      })
      response.on('error', () => finish(null))
    })

    const deadline = setTimeout(() => {
      request.destroy()
      finish(null)
    }, timeoutMs)

    request.once('error', () => finish(null))
  })
}

/**
 * IN-484 adoption handshake: a healthy listener on the backend port is only
 * OURS AT THE RIGHT VERSION if its /health echoes the exact app version the
 * supervisor injected at spawn (MN_APP_VERSION). Anything else — missing
 * field (pre-IN-484 orphan, manually-run dev uvicorn), version drift after
 * an update, an unrelated service squatting on the port — must be replaced,
 * not adopted: stale backends 404 newer routes, and a failing
 * enrolment-status route silently downgrades the renderer gate to Slice 1
 * local trust (observed bypassing central enrolment on a fleet machine,
 * 31 Jul 2026).
 */
export function shouldAdoptExistingBackend(
  health: Record<string, unknown> | null,
  appVersion: string
): boolean {
  if (!health || !appVersion) return false
  return health.app_version === appVersion
}

export interface BackendExitContext {
  stopRequested: boolean
  wasHealthy: boolean
}

/** Startup failures are retried by spawnAndWait; only a later unexpected exit
 * needs an immediate recovery run from the child exit handler. */
export function shouldRestartAfterBackendExit(context: BackendExitContext): boolean {
  return !context.stopRequested && context.wasHealthy
}
