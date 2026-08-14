/**
 * Call-watch registrar runtime layer (per-meeting amendment, spec E1/E3/E4).
 *
 * The engine and the reconciliation planner live in
 * `./call-watch-registrar-core`, which is deliberately Electron-free so the
 * verify harness can bundle it under plain Node. THIS file is the only
 * Electron-adjacent half: it wires the real dependencies and is what Task 10
 * imports.
 *
 * - Transport comes from `createCallWatchTransport()` (`./call-signals`), the
 *   SAME apiBase/http/identityHeaders assembly `armCallSignals` composes for
 *   its poller — so the registrar and the poller can never disagree on where
 *   the relay lives or how a request is authenticated. It is re-resolved on
 *   every sync: a null (kill switch, no scope, `configureCallSignals` not
 *   called yet) makes that pass dormant, and the next sync picks up whatever
 *   changed without a restart.
 * - The dormant log's `reason` is re-derived from `callSignalsEnvGate`
 *   (exported for exactly this): the transport declines without saying why,
 *   and field triage needs to tell a kill switch from a missing scope. The
 *   gate is read from `process.env` here; if the env gate passes but the
 *   transport still declined, the only remaining cause is
 *   `configureCallSignals` never having been called — reported as
 *   `not_configured`. (A Task-13 wiring that passed a CUSTOM env to
 *   `configureCallSignals` would make this reason approximate; the wiring
 *   uses `process.env`, so today the two always agree.)
 * - `hash` is `joinUrlHash` (sha256 hex, spec E2) — the single derivation
 *   shared with the poller and, byte for byte, with the storage API.
 *
 * Task 10 owns the wiring: it creates one registrar at startup (statePath
 * under userData), calls `handleSyncDecisions` after every calendar sync,
 * routes `hasActiveWatch` into `armCallSignals` (attach-mode pick, spec E5),
 * and leaves registrar-owned watches parked when a recording poller detaches.
 */

import { logger } from './logger'
import { callSignalsEnvGate, createCallWatchTransport, joinUrlHash, type CallSignalLog } from './call-signals'
import { createCallWatchRegistrarEngine, type CallWatchRegistrar } from './call-watch-registrar-core'

// The planner, state shapes, cap, and persistence helpers all belong to the
// core; re-exported so Task 10 has one import surface.
export * from './call-watch-registrar-core'

const defaultLog: CallSignalLog = (level, message, context) => {
  if (level === 'warn') logger().warn(message, context ?? {})
  else logger().info(message, context ?? {})
}

export interface CallWatchRegistrarOptions {
  /** Where the watch map persists (Task 10 puts it under userData, beside the
   *  graph scheduler state). Read once, synchronously, at creation. */
  statePath: string
  log?: CallSignalLog
}

/** Build the production registrar. See `createCallWatchRegistrarEngine` for
 *  the behaviour contract (serialization, failure philosophy, persistence). */
export function createCallWatchRegistrar(options: CallWatchRegistrarOptions): CallWatchRegistrar {
  return createCallWatchRegistrarEngine({
    statePath: options.statePath,
    log: options.log ?? defaultLog,
    transport: () => createCallWatchTransport(),
    dormantReason: () => {
      const gate = callSignalsEnvGate(process.env)
      return gate.ok ? 'not_configured' : gate.reason
    },
    hash: joinUrlHash
  })
}
