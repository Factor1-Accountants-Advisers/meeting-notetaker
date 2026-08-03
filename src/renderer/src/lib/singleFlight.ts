/**
 * Serialize an async action: while one invocation is in flight, further calls
 * are coalesced onto it (with an observable callback) instead of starting a
 * second run. The guard re-arms when the run settles — success or failure.
 *
 * Exists because the recording stop path used a hand-rolled `stopping` flag
 * that was only reset on failure: after one successful stop, every later stop
 * request (auto-stop timer, tray, on-screen button) was silently swallowed for
 * the rest of the session (field incident, 3 Aug 2026). A wrapper that resets
 * in `finally` makes that class of bug structurally impossible.
 */
export interface SingleFlight {
  /** Run the action, or join the in-flight run if one exists. */
  invoke: () => Promise<void>
  /** True while a run is in flight. */
  isRunning: () => boolean
}

export function createSingleFlight(
  run: () => Promise<void>,
  onCoalesced?: () => void
): SingleFlight {
  let inFlight: Promise<void> | null = null
  return {
    invoke: (): Promise<void> => {
      if (inFlight) {
        onCoalesced?.()
        return inFlight
      }
      inFlight = run().finally(() => {
        inFlight = null
      })
      return inFlight
    },
    isRunning: (): boolean => inFlight !== null
  }
}
