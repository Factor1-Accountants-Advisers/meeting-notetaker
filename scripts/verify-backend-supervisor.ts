import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probeHttpHealth, shouldRestartAfterBackendExit } from '../src/main/backend-health'

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected a TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function main(): Promise<void> {
  const healthyServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok"}')
  })
  const healthyPort = await listen(healthyServer)
  try {
    assert.equal(
      await probeHttpHealth(`http://127.0.0.1:${healthyPort}/health`, 250),
      true,
      'a 200 health response should be healthy'
    )
  } finally {
    await close(healthyServer)
  }

  const unhealthyServer = createServer((_req, res) => {
    res.writeHead(503)
    res.end('not ready')
  })
  const unhealthyPort = await listen(unhealthyServer)
  try {
    assert.equal(
      await probeHttpHealth(`http://127.0.0.1:${unhealthyPort}/health`, 250),
      false,
      'a non-2xx health response should be unhealthy'
    )
  } finally {
    await close(unhealthyServer)
  }

  const refusedServer = createServer()
  const refusedPort = await listen(refusedServer)
  await close(refusedServer)
  assert.equal(
    await probeHttpHealth(`http://127.0.0.1:${refusedPort}/health`, 250),
    false,
    'a refused local connection should be unhealthy'
  )

  const hangingServer = createServer(() => {
    // Accept the request but intentionally never send a response. This models
    // the Electron main-process fetch observed hanging during packaged startup.
  })
  const hangingPort = await listen(hangingServer)
  const startedAt = Date.now()
  try {
    assert.equal(
      await probeHttpHealth(`http://127.0.0.1:${hangingPort}/health`, 100),
      false,
      'a hung health endpoint should be unhealthy'
    )
    assert.ok(Date.now() - startedAt < 1_000, 'the hard probe timeout must release the supervisor promptly')
  } finally {
    hangingServer.closeAllConnections()
    await close(hangingServer)
  }

  assert.equal(
    shouldRestartAfterBackendExit({ stopRequested: false, wasHealthy: true }),
    true,
    'a healthy backend that exits unexpectedly must be restarted'
  )
  assert.equal(
    shouldRestartAfterBackendExit({ stopRequested: true, wasHealthy: true }),
    false,
    'an intentional app shutdown must not restart the backend'
  )
  assert.equal(
    shouldRestartAfterBackendExit({ stopRequested: false, wasHealthy: false }),
    false,
    'startup failures remain owned by the existing startup retry loop'
  )

  console.log('backend supervisor verification passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
