import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync('src/main/backend-supervisor.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function harness(packaged: boolean) {
  const commands: string[] = []
  const callbacks: Array<() => void> = []
  const exports: Record<string, (...args: unknown[]) => unknown> = {}
  const noop = () => undefined
  const dependencies: Record<string, unknown> = {
    electron: { app: { isPackaged: packaged, getVersion: () => 'fixture-version', getPath: () => 'private-test-data' }, dialog: { showErrorBox: noop } },
    child_process: {
      spawn: () => { throw new Error('No real child permitted') },
      execFileSync: (command: string) => {
        commands.push(command)
        return command === 'netstat' ? '  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    9876\n' : ''
      }
    },
    fs: { existsSync: () => false, readFileSync: () => { throw new Error('No pid file') }, copyFileSync: noop, mkdirSync: noop, writeFileSync: noop, unlinkSync: noop },
    path: { join },
    './logger': { getLogInfo: () => ({ backendLog: 'private-test.log' }), logger: () => ({ info: noop, warn: noop, error: noop }) },
    './tray': { setTrayAlert: noop },
    './backend-health': { fetchHealthJson: async () => ({ app_version: 'fixture-version' }), probeHttpHealth: async () => true, shouldAdoptExistingBackend: () => true, shouldRestartAfterBackendExit: () => false }
  }
  runInNewContext(compiled, {
    exports,
    require: (id: string) => { if (!(id in dependencies)) throw new Error('Unexpected dependency: ' + id); return dependencies[id] },
    process: { platform: 'win32', pid: 1234, resourcesPath: 'fixture-resources', env: {}, on: (_event: string, callback: () => void) => callbacks.push(callback), kill: noop },
    setTimeout
  })
  return { commands, exports, callbacks }
}

async function main() {
  const dev = harness(false)
  await dev.exports.startBackendSupervisor()
  dev.exports.stopBackendSupervisor()
  dev.exports.forceKillBackendChild()
  for (const callback of dev.callbacks) callback()
  assert.deepEqual(dev.commands, [], 'an unpackaged test app must never sweep or kill port 8787')
  const neverStarted = harness(true)
  neverStarted.exports.stopBackendSupervisor()
  assert.deepEqual(neverStarted.commands, [], 'loading a supervisor does not confer backend ownership')
  const adopted = harness(true)
  await adopted.exports.startBackendSupervisor()
  adopted.exports.stopBackendSupervisor()
  assert.deepEqual(adopted.commands, ['netstat', 'taskkill'], 'packaged adopted-backend cleanup remains supported')
  console.log('Backend supervisor ownership: 3 checks passed; no real processes touched')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
