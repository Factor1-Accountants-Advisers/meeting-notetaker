import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'

import { parseAudioEndpointLine } from './audio-endpoint-protocol'
import type { AudioEndpointSet, AudioEndpointSnapshot } from '../shared/audio-endpoints'

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

interface AudioEndpointServiceOptions {
  helperPath: string
  spawnHelper?: (helperPath: string) => AudioEndpointChild
  existsFn?: (path: string) => boolean
  scheduleRestart?: (callback: () => void, delayMs: number) => unknown
  cancelRestart?: (handle: unknown) => void
  onSnapshot?: (snapshot: AudioEndpointSnapshot) => void
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

function spawnAudioEndpointHelper(helperPath: string): AudioEndpointChild {
  return spawn(helperPath, [], {
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
  private readonly spawnHelper: (helperPath: string) => AudioEndpointChild
  private readonly scheduleRestart: (callback: () => void, delayMs: number) => unknown
  private readonly cancelRestart: (handle: unknown) => void
  private child: AudioEndpointChild | null = null
  private restartHandle: unknown = null
  private restartCount = 0
  private helperGeneration = 0
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
    let child: AudioEndpointChild
    try {
      child = this.spawnHelper(this.options.helperPath)
    } catch (error) {
      this.options.log.error('[audio-endpoints] observer could not start', {
        helperPath: this.options.helperPath,
        message: error instanceof Error ? error.message : String(error)
      })
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
      if (this.child === child) this.child = null
      this.scheduleOneRestart()
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
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
          this.options.log.warn('[audio-endpoints] ignored invalid observer output')
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
}
