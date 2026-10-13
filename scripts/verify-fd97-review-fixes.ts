import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { GraphClient } from '../src/main/graph/client'
import { startGraphDetectionRuntime, syncGraphDetectionOnce } from '../src/main/graph/runtime'
import { shouldHandleAutoStop } from '../src/renderer/src/lib/promptedCallStopGuard'

async function pagination() {
  const calls: string[] = []
  const client = new GraphClient({ getAccessToken: async () => 'fixture-token', fetchImpl: (async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify(calls.length === 1
      ? { value: [{ id: 'first' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?page=2' }
      : { value: [{ id: 'second' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?cursor=fixture' }), { status: 200 })
  }) as typeof fetch })
  const response = await client.fetchCalendarView({ startUtc: '2026-10-06T08:00:00Z', endUtc: '2026-10-07T08:00:00Z' })
  assert.deepEqual(response.value.map((event) => event.id), ['first', 'second'])
  assert.equal(response['@odata.nextLink'], undefined)
  assert.equal(calls.length, 2)
}

async function foreignPage() {
  let calls = 0
  const client = new GraphClient({ getAccessToken: async () => 'fixture-token', fetchImpl: (async () => {
    calls++
    return new Response(JSON.stringify({ value: [], '@odata.nextLink': 'https://untrusted.example/page' }), { status: 200 })
  }) as typeof fetch })
  await assert.rejects(client.fetchCalendarView({ startUtc: '2026-10-06T08:00:00Z', endUtc: '2026-10-07T08:00:00Z' }))
  assert.equal(calls, 1, 'never send a delegated token outside Graph')
}

async function syncCoalescing() {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'fd97-sync-'))
  let active = 0, maximum = 0, published = 0
  const client = { fetchCalendarView: async () => {
    maximum = Math.max(maximum, ++active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active--
    return { value: [] }
  }, fetchDeltaLink: async () => ({ value: [] }) }
  const runtime = startGraphDetectionRuntime({ statePath: join(dir, 'state.json'),
    getAccessToken: async () => 'fixture-token', logger: { info: () => {}, warn: () => {} },
    clientFactory: () => client, onSyncCompleted: () => { published++ } })
  try {
    await Promise.all([runtime.syncNow(), runtime.syncNow({ forceFullSnapshot: true })])
    assert.equal(maximum, 1, 'calendar sync must not overlap')
    assert.equal(published, 2, 'one startup snapshot and one coalesced forced refresh')
  } finally { runtime.stopPolling(); await rm(dir, { recursive: true, force: true }) }
}

async function accountSwitch() {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'fd97-account-'))
  let account = 'owner-a@factor1.com.au', published = 0
  try {
    const result = await syncGraphDetectionOnce({ statePath: join(dir, 'state.json'),
      getAccessToken: async () => 'fixture-token', getSignedInEmail: () => account,
      logger: { info: () => {}, warn: () => {} },
      clientFactory: () => ({ fetchCalendarView: async () => {
        account = 'owner-b@factor1.com.au'
        return { value: [] }
      }, fetchDeltaLink: async () => ({ value: [] }) }),
      onSyncCompleted: () => { published++ } })
    assert.notEqual(result.status, 'success')
    assert.equal(published, 0, 'an old account result cannot establish the new account calendar')
  } finally { await rm(dir, { recursive: true, force: true }) }
}

async function rejectedForcedQueueRecovers() {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'fd97-rejected-sync-'))
  let rejectToken!: (error: Error) => void
  const firstToken = new Promise<string>((_resolve, reject) => { rejectToken = reject })
  let tokenCalled = false, tokenHealthy = false, blockFetch = false
  let releaseFetch: (() => void) | undefined
  let fetches = 0
  const runtime = startGraphDetectionRuntime({ statePath: join(dir, 'state.json'),
    getAccessToken: async () => { tokenCalled = true; return tokenHealthy ? 'fixture-token' : firstToken },
    logger: { info: () => {}, warn: () => {} },
    clientFactory: () => ({ fetchCalendarView: async () => {
      fetches++
      if (blockFetch) await new Promise<void>(resolve => { releaseFetch = resolve })
      return { value: [] }
    }, fetchDeltaLink: async () => ({ value: [] }) }) })
  try {
    const initial = Promise.allSettled([runtime.syncNow(), runtime.syncNow({ forceFullSnapshot: true })])
    while (!tokenCalled) await new Promise(resolve => setTimeout(resolve, 1))
    rejectToken(new Error('fixture token unavailable'))
    const failed = await initial
    assert.ok(failed.every(result => result.status === 'rejected'))
    tokenHealthy = true
    assert.equal((await runtime.syncNow({ forceFullSnapshot: true })).status, 'success', 'idle refresh can recover')
    blockFetch = true
    const active = runtime.syncNow()
    const queued = runtime.syncNow({ forceFullSnapshot: true })
    const results = Promise.allSettled([active, queued])
    while (!releaseFetch) await new Promise(resolve => setTimeout(resolve, 1))
    blockFetch = false
    releaseFetch()
    const recovered = await results
    assert.ok(recovered.every(result => result.status === 'fulfilled'), 'later concurrent forced refresh must not reuse the stale rejection')
    assert.equal(fetches, 3, 'recovered queue must issue its full snapshot after active sync')
  } finally { releaseFetch?.(); runtime.stopPolling(); await rm(dir, { recursive: true, force: true }) }
}

async function hooksBeforeEarlyReturn() {
  const source = ts.createSourceFile('App.tsx', readFileSync('src/renderer/src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const app = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'App')
  assert.ok(app?.body)
  const early = app.body.statements.find((node) => ts.isIfStatement(node) && /return/.test(node.getText(source)))
  assert.ok(early)
  for (const node of app.body.statements) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect') {
      assert.ok(node.pos < early.pos, 'useEffect after a login early return changes React hook order')
    }
  }
}

async function automaticStopCannotHitReplacement() {
  assert.equal(shouldHandleAutoStop('scheduled-a', 'scheduled-a', null), true)
  assert.equal(shouldHandleAutoStop('scheduled-a', 'scheduled-b', null), false)
  assert.equal(shouldHandleAutoStop('scheduled-a', 'manual-b', null), false)
  assert.equal(shouldHandleAutoStop('scheduled-a', null, null), false)
  assert.equal(shouldHandleAutoStop('scheduled-a', undefined, null), false)
  assert.equal(shouldHandleAutoStop('', '', null), false)
  assert.equal(shouldHandleAutoStop('manual-a', 'manual-a', null), true)
  assert.equal(shouldHandleAutoStop('teams-prompt-n1', 'teams-prompt-n1', 'n1'), true)
  assert.equal(shouldHandleAutoStop('teams-prompt-n1', 'teams-prompt-n2', 'n2'), false)
  assert.equal(shouldHandleAutoStop('teams-prompt-n1', 'teams-prompt-n1', 'n2'), false)
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  assert.match(app, /recordingKey:\s*data\.idempotencyKey/, 'auto-start must retain the exact main-process identity')
  assert.match(app, /recordingKey:\s*manualKey/, 'timed manual capture must retain its registered identity')
  assert.match(app, /shouldHandleAutoStop\([\s\S]*?recordingRef\.current\?\.recordingKey/, 'real stop callback must apply the identity guard')
}

;(async () => {
  const checks = [pagination, foreignPage, syncCoalescing, rejectedForcedQueueRecovers, accountSwitch, hooksBeforeEarlyReturn, automaticStopCannotHitReplacement]
  let failed = 0
  for (const check of checks) {
    try { await check(); console.log('PASS ' + check.name) }
    catch (error) { failed++; console.error('FAIL ' + check.name + ': ' + String(error)) }
  }
  assert.equal(failed, 0)
  console.log('Review regression checks passed: ' + checks.length)
})().catch((error) => { console.error(error); process.exitCode = 1 })
