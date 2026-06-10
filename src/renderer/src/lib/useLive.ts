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
    fetcher().then((live) => {
      if (cancelled) return
      if (live !== null) {
        setData(live)
        setOffline(false)
      } else {
        setOffline(true)
      }
    })
    return () => {
      cancelled = true
    }
    // Fetch once per mount; fetchers are stable module functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { data, offline, setData }
}
