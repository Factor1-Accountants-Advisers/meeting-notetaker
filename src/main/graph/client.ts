import type { RawGraphEvent } from './types'

export interface GraphClientOptions {
  getAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export interface CalendarViewRequest {
  startUtc: string
  endUtc: string
}

export interface GraphCollectionResponse<T> {
  value: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

export class GraphThrottleError extends Error {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(`Microsoft Graph throttled the request; retry after ${retryAfterMs}ms`)
    this.name = 'GraphThrottleError'
    this.retryAfterMs = retryAfterMs
  }
}

export class GraphClientError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GraphClientError'
    this.status = status
  }
}

export class GraphClient {
  private readonly getAccessToken: () => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: GraphClientOptions) {
    this.getAccessToken = options.getAccessToken
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? 'https://graph.microsoft.com/v1.0'
  }

  async fetchCalendarView(
    request: CalendarViewRequest
  ): Promise<GraphCollectionResponse<RawGraphEvent>> {
    const params = new URLSearchParams({
      startDateTime: request.startUtc,
      endDateTime: request.endUtc
    })
    return this.fetchCollection(`${this.baseUrl}/me/calendarView?${params.toString()}`)
  }

  async fetchDeltaLink(deltaLink: string): Promise<GraphCollectionResponse<RawGraphEvent>> {
    return this.fetchCollection(deltaLink)
  }

  private async fetchCollection(url: string): Promise<GraphCollectionResponse<RawGraphEvent>> {
    const token = await this.getAccessToken()
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: ['Bearer', token].join(' '),
        accept: 'application/json',
        Prefer: 'outlook.timezone="UTC"'
      }
    })

    if (response.status === 429) {
      throw new GraphThrottleError(getRetryAfterMs(response.headers.get('retry-after')))
    }
    if (!response.ok) {
      throw new GraphClientError(response.status, `Microsoft Graph request failed with ${response.status}`)
    }
    return (await response.json()) as GraphCollectionResponse<RawGraphEvent>
  }
}

export function getRetryAfterMs(retryAfter: string | null): number {
  if (!retryAfter) return 30_000

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const dateMs = new Date(retryAfter).getTime()
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())

  return 30_000
}
