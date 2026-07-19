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

export interface BackendExitContext {
  stopRequested: boolean
  wasHealthy: boolean
}

/** Startup failures are retried by spawnAndWait; only a later unexpected exit
 * needs an immediate recovery run from the child exit handler. */
export function shouldRestartAfterBackendExit(context: BackendExitContext): boolean {
  return !context.stopRequested && context.wasHealthy
}
