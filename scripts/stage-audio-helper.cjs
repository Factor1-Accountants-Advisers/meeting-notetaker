// Stage the audio endpoint helper into a clean dir for electron-builder.
// A directory extraResources mapping keeps electron-builder 26's Windows
// signing transformer engaged (single-file mappings bypass it), and staging
// keeps electron-builder out of the cargo target/ tree (the 4 Aug 213MB
// installer came from walking it).
const { copyFileSync, mkdirSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', 'native', 'audio-endpoint-monitor')
const built = join(root, 'target', 'release', 'notetaker-audio-endpoints.exe')
const dist = join(root, 'dist')

if (!existsSync(built)) {
  console.error(`stage-audio-helper: missing ${built} — run the cargo build first`)
  process.exit(1)
}
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
copyFileSync(built, join(dist, 'notetaker-audio-endpoints.exe'))
console.log('stage-audio-helper: staged notetaker-audio-endpoints.exe')
