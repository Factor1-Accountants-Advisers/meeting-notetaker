import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEC_UNAVAILABLE_WARNING,
  clearTokenCache,
  loadTokenCache,
  persistTokenCache,
  type CacheCodec,
  type CacheStoreLog,
  type CacheStorePaths
} from '../src/main/token-cache-store'

const MAGIC = 'MNENC1:'

/** Stand-in for Electron safeStorage: base64 with a magic prefix. */
const fakeCodec: CacheCodec = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(MAGIC + Buffer.from(plaintext, 'utf-8').toString('base64')),
  decrypt: (ciphertext) => {
    const text = ciphertext.toString('utf-8')
    if (!text.startsWith(MAGIC)) throw new Error('bad magic')
    return Buffer.from(text.slice(MAGIC.length), 'base64').toString('utf-8')
  }
}

const brokenCodec: CacheCodec = {
  isAvailable: () => true,
  encrypt: () => {
    throw new Error('broken codec cannot encrypt')
  },
  decrypt: () => {
    throw new Error('broken codec cannot decrypt')
  }
}

const unavailableCodec: CacheCodec = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('encrypt must not be called when unavailable')
  },
  decrypt: () => {
    throw new Error('decrypt must not be called when unavailable')
  }
}

function collectingLog(): { log: CacheStoreLog; warnings: string[] } {
  const warnings: string[] = []
  return { log: { warn: (message) => warnings.push(message) }, warnings }
}

function withTempStore(fn: (paths: CacheStorePaths) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mn-token-cache-'))
  try {
    // The store creates directories on persist; tests that pre-seed a legacy
    // file need the parent to exist first.
    mkdirSync(join(dir, 'auth'), { recursive: true })
    fn({
      encryptedPath: join(dir, 'auth', 'msal-cache.bin'),
      legacyPlaintextPath: join(dir, 'auth', 'msal-cache.json')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SERIALIZED = JSON.stringify({ RefreshToken: { key: 'fake-refresh-token' } })

async function main(): Promise<void> {
  // 1. Encrypt/persist/load round-trip; ciphertext on disk, no plaintext leak.
  withTempStore((paths) => {
    const { log, warnings } = collectingLog()
    persistTokenCache(paths, fakeCodec, log, SERIALIZED)
    assert.equal(existsSync(paths.encryptedPath), true, 'persist must write the encrypted file')
    assert.equal(existsSync(paths.legacyPlaintextPath), false, 'persist must not write plaintext')
    assert.equal(
      existsSync(`${paths.encryptedPath}.tmp`),
      false,
      'the tmp file must be renamed away'
    )
    const onDisk = readFileSync(paths.encryptedPath).toString('utf-8')
    assert.equal(onDisk.startsWith(MAGIC), true, 'on-disk bytes must be codec output')
    assert.equal(
      onDisk.includes('fake-refresh-token'),
      false,
      'the serialized cache must not appear in plaintext on disk'
    )
    assert.equal(
      loadTokenCache(paths, fakeCodec, log),
      SERIALIZED,
      'load must round-trip the persisted cache'
    )
    assert.deepEqual(warnings, [], 'the happy path must not warn')
  })

  // 2. Legacy migration: plaintext present -> content returned, encrypted
  //    file created, legacy deleted.
  withTempStore((paths) => {
    const { log, warnings } = collectingLog()
    writeFileSync(paths.legacyPlaintextPath, SERIALIZED, 'utf-8')
    assert.equal(
      loadTokenCache(paths, fakeCodec, log),
      SERIALIZED,
      'migration load must return the legacy content'
    )
    assert.equal(existsSync(paths.encryptedPath), true, 'migration must create the encrypted file')
    assert.equal(
      existsSync(paths.legacyPlaintextPath),
      false,
      'migration must delete the legacy plaintext file'
    )
    assert.deepEqual(warnings, [], 'a clean migration must not warn')
    assert.equal(
      loadTokenCache(paths, fakeCodec, log),
      SERIALIZED,
      'a post-migration load must read the encrypted file'
    )
  })

  // 3. Corrupt encrypted cache -> null, both files gone, warning logged.
  withTempStore((paths) => {
    const { log, warnings } = collectingLog()
    persistTokenCache(paths, fakeCodec, log, SERIALIZED)
    writeFileSync(paths.encryptedPath, Buffer.from('garbage-not-ciphertext'))
    writeFileSync(paths.legacyPlaintextPath, SERIALIZED, 'utf-8') // stray legacy copy too
    assert.equal(loadTokenCache(paths, fakeCodec, log), null, 'corrupt cache must load as null')
    assert.equal(existsSync(paths.encryptedPath), false, 'corrupt encrypted file must be deleted')
    assert.equal(
      existsSync(paths.legacyPlaintextPath),
      false,
      'the legacy file must be deleted alongside a corrupt encrypted cache'
    )
    assert.equal(warnings.length, 1, 'corruption must warn exactly once')

    // Same degradation when the codec itself throws on decrypt.
    const broken = collectingLog()
    persistTokenCache(paths, fakeCodec, broken.log, SERIALIZED)
    assert.equal(
      loadTokenCache(paths, brokenCodec, broken.log),
      null,
      'an undecryptable cache must load as null'
    )
    assert.equal(existsSync(paths.encryptedPath), false, 'undecryptable file must be deleted')
    assert.equal(broken.warnings.length, 1, 'undecryptable cache must warn')
  })

  // 4. Codec unavailable -> plaintext fallback with warning, both directions.
  withTempStore((paths) => {
    const { log, warnings } = collectingLog()
    persistTokenCache(paths, unavailableCodec, log, SERIALIZED)
    assert.equal(
      existsSync(paths.legacyPlaintextPath),
      true,
      'unavailable codec must fall back to the plaintext file'
    )
    assert.equal(existsSync(paths.encryptedPath), false, 'no encrypted file without a codec')
    assert.equal(
      loadTokenCache(paths, unavailableCodec, log),
      SERIALIZED,
      'unavailable codec must read the plaintext file back'
    )
    assert.equal(
      warnings.filter((w) => w === CODEC_UNAVAILABLE_WARNING).length >= 2,
      true,
      'both persist and load must warn when the codec is unavailable'
    )
  })

  // 4b. Encrypted file present but codec unavailable -> null (signed-out),
  //     file preserved for when the codec returns.
  withTempStore((paths) => {
    const good = collectingLog()
    persistTokenCache(paths, fakeCodec, good.log, SERIALIZED)
    const { log, warnings } = collectingLog()
    assert.equal(
      loadTokenCache(paths, unavailableCodec, log),
      null,
      'an encrypted cache is unreadable without the codec — degrade to signed-out'
    )
    assert.equal(
      existsSync(paths.encryptedPath),
      true,
      'the encrypted file must survive a transient codec outage'
    )
    assert.equal(warnings.length, 1, 'the outage must warn')
  })

  // 5. clearTokenCache removes both forms.
  withTempStore((paths) => {
    const { log } = collectingLog()
    persistTokenCache(paths, fakeCodec, log, SERIALIZED)
    writeFileSync(paths.legacyPlaintextPath, SERIALIZED, 'utf-8')
    clearTokenCache(paths)
    assert.equal(existsSync(paths.encryptedPath), false, 'clear must remove the encrypted file')
    assert.equal(
      existsSync(paths.legacyPlaintextPath),
      false,
      'clear must remove the legacy plaintext file'
    )
  })

  // 6. Neither file present -> null, no warnings.
  withTempStore((paths) => {
    const { log, warnings } = collectingLog()
    assert.equal(loadTokenCache(paths, fakeCodec, log), null, 'no files must load as null')
    assert.deepEqual(warnings, [], 'an empty store must not warn')
  })

  // 7. Persist with an available codec removes a lingering plaintext copy.
  withTempStore((paths) => {
    const { log } = collectingLog()
    writeFileSync(paths.legacyPlaintextPath, 'stale-plaintext', 'utf-8')
    persistTokenCache(paths, fakeCodec, log, SERIALIZED)
    assert.equal(
      existsSync(paths.legacyPlaintextPath),
      false,
      'persist must sweep away a lingering plaintext copy'
    )
  })

  console.log('Token cache store verification passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
