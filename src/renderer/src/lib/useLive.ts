import { useEffect, useState } from 'react'

/**
 * Load live data from the backend with a sample-data fallback.
 * `offline` flips true when the backend is unreachable so screens can say so.
 */
export function useLive<T>(
  fetcher: () => Promise<T | null>,
  sample: T
): { data: T; offline: boolean; setData: React.Dispatch<React.SetStateAction<T>> } {
  const [data, setData] = useState<T>(sample)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // On a cold app launch the packaged backend can take several seconds to
    // become healthy; a single failed fetch would strand the screen on sample
    // data until remount. Retry on a short backoff before giving up.
    const retryDelaysMs = [2_000, 5_000, 10_000, 20_000]
    let attempt = 0

    const load = (): void => {
      fetcher().then((live) => {
        if (cancelled) return
        if (live !== null) {
          setData(live)
          setOffline(false)
        } else {
          setOffline(true)
          if (attempt < retryDelaysMs.length) {
            timer = setTimeout(load, retryDelaysMs[attempt])
            attempt += 1
          }
        }
      })
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // Fetch per mount (with offline retries); fetchers are stable module functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { data, offline, setData }
}
