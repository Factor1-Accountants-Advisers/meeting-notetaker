// Persistence for the serialized MSAL token cache (refresh tokens for
// Mail.Send / SharePoint / Storage API). Pure fs + injected-codec logic —
// no Electron imports — so verify-token-cache.ts can exercise every path
// without an Electron runtime (same pattern as update-gate.ts).
//
// Trust/availability posture:
// - fail CLOSED on trust: a corrupt or undecryptable encrypted cache is
//   deleted (both file forms) and load returns null — the user signs in
//   again; startup never crashes on a bad cache.
// - fail OPEN on auth availability: if the codec (Electron safeStorage /
//   DPAPI) is unavailable, warn and fall back to legacy plaintext behaviour
//   rather than bricking sign-in.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface CacheCodec {
  isAvailable(): boolean
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export interface CacheStorePaths {
  /** Encrypted (binary) cache file — the current format. */
  encryptedPath: string
  /** Legacy plaintext cache file — read for one-time migration only. */
  legacyPlaintextPath: string
}

export interface CacheStoreLog {
  warn(message: string, meta?: Record<string, unknown>): void
}

export const CODEC_UNAVAILABLE_WARNING =
  '[auth] token-cache encryption unavailable; falling back to plaintext cache'

function readFileOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already absent or never written
  }
}

/** Write via tmp-then-rename so a crash mid-write cannot leave a truncated
 * cache file behind (rename replaces atomically-enough on the same volume). */
function writeFileAtomicish(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, data)
  renameSync(tmpPath, path)
}

/**
 * Load the persisted cache, handling in order:
 * - encrypted file present -> decrypt (corrupt => delete both forms, warn,
 *   return null); if the codec is unavailable the encrypted bytes are
 *   unreadable — warn and return null (signed-out), keeping the file so a
 *   transient DPAPI outage does not destroy the session.
 * - only legacy plaintext present -> return its content; when the codec is
 *   available, re-persist encrypted and delete the plaintext (one-time
 *   migration); when unavailable, warn and keep legacy behaviour.
 * - neither present -> null.
 */
export function loadTokenCache(
  paths: CacheStorePaths,
  codec: CacheCodec,
  log: CacheStoreLog
): string | null {
  const encrypted = readFileOrNull(paths.encryptedPath)
  if (encrypted !== null) {
    if (!codec.isAvailable()) {
      log.warn(CODEC_UNAVAILABLE_WARNING, { detail: 'encrypted cache present but undecryptable' })
      return null
    }
    try {
      return codec.decrypt(encrypted)
    } catch (err) {
      // Fail closed on trust: discard the cache entirely and sign out.
      unlinkIfPresent(paths.encryptedPath)
      unlinkIfPresent(paths.legacyPlaintextPath)
      log.warn('[auth] token cache was corrupt or undecryptable; cleared — sign-in required', {
        message: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  const legacy = readFileOrNull(paths.legacyPlaintextPath)
  if (legacy === null) return null
  const serialized = legacy.toString('utf-8')

  if (!codec.isAvailable()) {
    log.warn(CODEC_UNAVAILABLE_WARNING)
    return serialized
  }

  // One-time migration: re-persist encrypted, then delete the plaintext copy.
  try {
    writeFileAtomicish(paths.encryptedPath, codec.encrypt(serialized))
    unlinkIfPresent(paths.legacyPlaintextPath)
  } catch (err) {
    // Migration failure must not cost the user their session; the next
    // persist will retry the encrypted write.
    log.warn('[auth] token cache migration to encrypted storage failed; keeping legacy file', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
  return serialized
}

/**
 * Persist the serialized cache. Codec available -> encrypted file (and any
 * lingering plaintext copy is removed so stale refresh tokens do not remain
 * on disk); unavailable -> legacy plaintext with a warning.
 */
export function persistTokenCache(
  paths: CacheStorePaths,
  codec: CacheCodec,
  log: CacheStoreLog,
  serialized: string
): void {
  if (!codec.isAvailable()) {
    log.warn(CODEC_UNAVAILABLE_WARNING)
    writeFileAtomicish(paths.legacyPlaintextPath, Buffer.from(serialized, 'utf-8'))
    return
  }
  writeFileAtomicish(paths.encryptedPath, codec.encrypt(serialized))
  unlinkIfPresent(paths.legacyPlaintextPath)
}

/** Sign-out: remove BOTH file forms (and any interrupted tmp writes). */
export function clearTokenCache(paths: CacheStorePaths): void {
  unlinkIfPresent(paths.encryptedPath)
  unlinkIfPresent(paths.legacyPlaintextPath)
  unlinkIfPresent(`${paths.encryptedPath}.tmp`)
  unlinkIfPresent(`${paths.legacyPlaintextPath}.tmp`)
}
