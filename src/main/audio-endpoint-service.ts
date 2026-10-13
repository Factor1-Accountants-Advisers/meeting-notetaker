import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'

import { parseAudioEndpointLine, parseTeamsCallLine } from './audio-endpoint-protocol'
import type {
  AudioEndpointSet,
  AudioEndpointSnapshot,
  TeamsCallObservation
} from '../shared/audio-endpoints'

const MAX_PENDING_STDOUT_BYTES = 64 * 1024
const RESTART_DELAY_MS = 1_000

export interface AudioEndpointChild extends EventEmitter {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  kill(): boolean
}

interface AudioEndpointLog {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}

export interface AudioEndpointServiceOptions {
  helperPath: string
  spawnHelper?: (helperPath: string, args?: readonly string[]) => AudioEndpointChild
  existsFn?: (path: string) => boolean
  scheduleRestart?: (callback: () => void, delayMs: number) => unknown
  cancelRestart?: (handle: unknown) => void
  onSnapshot?: (snapshot: AudioEndpointSnapshot) => void
  observeTeams?: () => boolean
  onTeamsCall?: (observation: TeamsCallObservation) => void
  onTeamsUnavailable?: () => void
  log: AudioEndpointLog
}

interface HelperPathOptions {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

export function resolveAudioEndpointHelperPath(options: HelperPathOptions): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, 'audio', 'notetaker-audio-endpoints.exe')
  }
  return join(
    options.appPath,
    'native',
    'audio-endpoint-monitor',
    'target',
    'release',
    'notetaker-audio-endpoints.exe'
  )
}

function spawnAudioEndpointHelper(
  helperPath: string,
  args: readonly string[] = []
): AudioEndpointChild {
  return spawn(helperPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }) as AudioEndpointChild
}

function endpointSetsMatch(left: AudioEndpointSet, right: AudioEndpointSet): boolean {
  const keys = [
    'captureConsole',
    'captureCommunications',
    'renderConsole',
    'renderCommunications'
  ] as const satisfies readonly (keyof AudioEndpointSet)[]
  return keys.every((key) => {
    const leftEndpoint = left[key]
    const rightEndpoint = right[key]
    return (
      leftEndpoint === rightEndpoint ||
      (leftEndpoint !== null &&
        rightEndpoint !== null &&
        leftEndpoint.id === rightEndpoint.id &&
        leftEndpoint.label === rightEndpoint.label)
    )
  })
}

/**
 * Owns the small Windows observer process and converts its JSONL stdout into
 * a monotonic endpoint stream. The service has a deliberately bounded restart
 * policy: one unexpected exit is retried, a second degrades to Chromium-only
 * capture until the app is restarted.
 */
export class AudioEndpointService {
  private readonly spawnHelper: (
    helperPath: string,
    args?: readonly string[]
  ) => AudioEndpointChild
  private readonly scheduleRestart: (callback: () => void, delayMs: number) => unknown
  private readonly cancelRestart: (handle: unknown) => void
  private child: AudioEndpointChild | null = null
  private restartHandle: unknown = null
  private restartCount = 0
  private helperGeneration = 0
  private teamsHelperGeneration = 0
  private observingTeams = false
  private teamsUnavailableNotified = false
  private stdoutBuffer = ''
  private snapshot: AudioEndpointSnapshot | null = null
  private started = false
  private stopRequested = false

  constructor(private readonly options: AudioEndpointServiceOptions) {
    this.spawnHelper = options.spawnHelper ?? spawnAudioEndpointHelper
    this.scheduleRestart = options.scheduleRestart ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelRestart = options.cancelRestart ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  start(): void {
    if (this.started) return
    // Dev machines before a cargo build (and broken installs) have no helper
    // exe; observation is optional, so degrade with one warning, no restarts.
    if (!(this.options.existsFn ?? existsSync)(this.options.helperPath)) {
      this.options.log.warn(
        `[audio-endpoints] helper binary not found at ${this.options.helperPath}; endpoint observation disabled`
      )
      return
    }
    this.started = true
    this.stopRequested = false
    this.restartCount = 0
    this.spawnObserver()
  }

  stop(): void {
    this.stopRequested = true
    this.started = false
    this.invalidateTeamsObservation()
    if (this.restartHandle !== null) {
      this.cancelRestart(this.restartHandle)
      this.restartHandle = null
    }
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch (error) {
        this.options.log.warn('[audio-endpoints] could not stop observer', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  getSnapshot(): AudioEndpointSnapshot | null {
    return this.snapshot
  }

  private spawnObserver(): void {
    if (this.stopRequested) return
    this.stdoutBuffer = ''
    this.helperGeneration = 0
    this.teamsHelperGeneration = 0
    this.observingTeams = this.options.observeTeams?.() === true
    this.teamsUnavailableNotified = false
    const spawnArgs = this.observingTeams ? ['--observe-teams'] : []
    let child: AudioEndpointChild
    try {
      child = this.spawnHelper(this.options.helperPath, spawnArgs)
    } catch (error) {
      this.options.log.error('[audio-endpoints] observer could not start', {
        helperPath: this.options.helperPath,
        message: error instanceof Error ? error.message : String(error)
      })
      this.invalidateTeamsObservation()
      this.scheduleOneRestart()
      return
    }

    this.child = child
    this.options.log.info('[audio-endpoints] observer started', {
      helperPath: this.options.helperPath,
      restartCount: this.restartCount
    })

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (this.child === child) this.consumeStdout(String(chunk))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim()
      if (message) this.options.log.warn('[audio-endpoints] observer diagnostic', { message })
    })
    child.once('error', (error) => {
      this.options.log.error('[audio-endpoints] observer process error', {
        message: error instanceof Error ? error.message : String(error)
      })
      if (this.child === child) {
        this.child = null
        this.invalidateTeamsObservation()
      }
      this.scheduleOneRestart()
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this.invalidateTeamsObservation()
      }
      if (this.stopRequested) return
      this.options.log.warn('[audio-endpoints] observer exited unexpectedly', { code, signal })
      this.scheduleOneRestart()
    })
  }

  private scheduleOneRestart(): void {
    if (this.stopRequested || this.restartHandle !== null) return
    if (this.restartCount >= 1) {
      this.options.log.error('[audio-endpoints] observer unavailable; using Chromium fallback')
      return
    }
    this.restartCount += 1
    this.restartHandle = this.scheduleRestart(() => {
      this.restartHandle = null
      this.spawnObserver()
    }, RESTART_DELAY_MS)
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_PENDING_STDOUT_BYTES) {
      this.options.log.warn('[audio-endpoints] discarded oversized observer output')
      this.stdoutBuffer = ''
      this.invalidateTeamsObservation()
      return
    }

    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const snapshot = parseAudioEndpointLine(trimmed)
        if (!snapshot) {
          const observation = parseTeamsCallLine(trimmed)
          if (observation) {
            if (observation.generation <= this.teamsHelperGeneration) continue
            this.teamsHelperGeneration = observation.generation
            this.teamsUnavailableNotified = false
            this.options.onTeamsCall?.(observation)
            continue
          }
          this.options.log.warn('[audio-endpoints] ignored invalid observer output')
          this.invalidateTeamsObservation()
          continue
        }
        if (snapshot.generation <= this.helperGeneration) continue
        this.helperGeneration = snapshot.generation
        if (this.snapshot && endpointSetsMatch(snapshot.endpoints, this.snapshot.endpoints)) continue
        const serviceSnapshot: AudioEndpointSnapshot = {
          ...snapshot,
          generation: (this.snapshot?.generation ?? 0) + 1
        }
        this.snapshot = serviceSnapshot
        this.options.onSnapshot?.(serviceSnapshot)
      } catch (error) {
        this.options.log.warn('[audio-endpoints] ignored invalid observer output', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  private invalidateTeamsObservation(): void {
    if (!this.observingTeams || this.teamsUnavailableNotified) return
    this.teamsUnavailableNotified = true
    this.options.onTeamsUnavailable?.()
  }
}
