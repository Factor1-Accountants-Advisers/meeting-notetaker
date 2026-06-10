import { useEffect, useRef, useState } from 'react'
import { fetchMeetings } from './api'
import type { Meeting, PipelineStatus } from '@renderer/data/mock'

export interface AppNotification {
  id: string
  meetingId: string
  text: string
  at: number
  read: boolean
}

const POLL_MS = 10_000
const MAX_ITEMS = 20

/** Watches pipeline transitions and turns them into bell notifications. */
export function useNotifications(enabled: boolean): {
  items: AppNotification[]
  unread: number
  markAllRead: () => void
} {
  const [items, setItems] = useState<AppNotification[]>([])
  const prevRef = useRef<Map<string, PipelineStatus> | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const tick = async (): Promise<void> => {
      const meetings = await fetchMeetings()
      if (cancelled || !meetings) return
      const prev = prevRef.current
      const next = new Map(meetings.map((m) => [m.id, m.pipelineStatus]))
      if (prev !== null) {
        const fresh: AppNotification[] = []
        for (const m of meetings) {
          const before = prev.get(m.id)
          if (before === undefined || before === m.pipelineStatus) continue
          if (m.pipelineStatus === 'ready') {
            fresh.push(makeNotification(m, `“${m.title}” finished processing.`))
            if (m.unknownSpeakers > 0) {
              fresh.push(
                makeNotification(
                  m,
                  `${m.unknownSpeakers} speaker${m.unknownSpeakers > 1 ? 's' : ''} to name in “${m.title}”.`
                )
              )
            }
          } else if (m.pipelineStatus === 'failed') {
            fresh.push(makeNotification(m, `Processing failed for “${m.title}”.`))
          }
        }
        if (fresh.length > 0) {
          setItems((current) => [...fresh, ...current].slice(0, MAX_ITEMS))
        }
      }
      prevRef.current = next
    }

    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [enabled])

  return {
    items,
    unread: items.filter((n) => !n.read).length,
    markAllRead: () => setItems((current) => current.map((n) => ({ ...n, read: true })))
  }
}

function makeNotification(meeting: Meeting, text: string): AppNotification {
  return {
    id: `${meeting.id}-${meeting.pipelineStatus}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    meetingId: meeting.id,
    text,
    at: Date.now(),
    read: false
  }
}
