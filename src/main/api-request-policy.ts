export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

export function loggablePath(path: string): string {
  return path.split('?')[0]
}

export function timeoutMsFor(req: ApiRequest): number {
  const path = loggablePath(req.path)
  if (req.method === 'POST' && path.endsWith('/audio')) return 120_000
  if (req.method === 'POST' && path.endsWith('/email')) return 90_000
  if (req.method === 'POST' && path.endsWith('/enroll')) return 180_000
  if (req.method === 'POST') return 30_000
  return 15_000
}

// IN-383: pipeline-kicking routes also carry a delegated Graph token so the
// backend can read the company context file from SharePoint at summarisation
// time. Deliberately narrower than isStorageRoute — finalize/blob-retry never
// re-run generation, so they have no use for a Graph token.
export function isPipelineKickRoute(req: Pick<ApiRequest, 'method' | 'path'>): boolean {
  return (
    req.method === 'POST' &&
    /^\/api\/v1\/meetings\/[^/]+\/(?:audio|retry)$/.test(loggablePath(req.path))
  )
}

export function isStorageRoute(req: Pick<ApiRequest, 'method' | 'path'>): boolean {
  const path = loggablePath(req.path)
  const storageBackedMeetingRoute =
    req.method === 'POST' &&
    /^\/api\/v1\/meetings\/[^/]+\/(?:audio|retry|finalize|blob\/retry)$/.test(path)
  return (
    storageBackedMeetingRoute ||
    /^\/api\/v1\/voiceprint-admin(?:\/|$)/.test(path) ||
    (req.method === 'GET' && path === '/api/v1/people/me/enrolment-status') ||
    // Central people directory merge (5 Aug 2026): the people list consults
    // the central voiceprint store when a storage identity rides along.
    (req.method === 'GET' && path === '/api/v1/people') ||
    (req.method === 'POST' && /^\/api\/v1\/people\/[^/]+\/enroll$/.test(path))
  )
}
