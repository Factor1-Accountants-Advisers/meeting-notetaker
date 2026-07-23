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

export function isStorageRoute(req: Pick<ApiRequest, 'method' | 'path'>): boolean {
  const path = loggablePath(req.path)
  const meetingProcessingRoute =
    req.method === 'POST' &&
    /^\/api\/v1\/meetings\/[^/]+\/(?:audio|retry)$/.test(path)
  return (
    meetingProcessingRoute ||
    (req.method === 'GET' && path === '/api/v1/people/me/enrolment-status') ||
    (req.method === 'POST' && /^\/api\/v1\/people\/[^/]+\/enroll$/.test(path))
  )
}
