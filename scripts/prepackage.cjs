// Pre-package checks: assert backend bundle + credentials exist before
// invoking electron-builder.  Called by scripts/package:win.
const fs = require('fs')
const path = require('path')

const bundleExe = 'backend/dist/notetaker-backend/notetaker-backend.exe'
const envFile = 'backend.env'
const bundleEnvDest = 'backend/dist/notetaker-backend/backend.env'

// 1. Backend bundle must exist.
if (!fs.existsSync(bundleExe)) {
  console.error('Backend bundle missing: ' + bundleExe)
  console.error('Run the backend PyInstaller build first (see docs/windows-backend-build.md).')
  process.exit(1)
}

// 2. ffmpeg must be inside the bundle — the spec includes it conditionally,
// so a build without backend/third_party/ffmpeg/ffmpeg.exe would otherwise
// ship silently broken dual-track merging and silence detection.
const ffmpegCandidates = [
  'backend/dist/notetaker-backend/_internal/ffmpeg/ffmpeg.exe', // PyInstaller 6.x onedir
  'backend/dist/notetaker-backend/ffmpeg/ffmpeg.exe', // older onedir layout
]
if (!ffmpegCandidates.some((p) => fs.existsSync(p))) {
  console.error('ffmpeg missing from bundle (checked: ' + ffmpegCandidates.join(', ') + ')')
  console.error('Download ffmpeg per docs/windows-backend-build.md step 4, then rebuild the bundle.')
  process.exit(1)
}

// 3. Idle + recording (IN-495) tray icons. Shipping only one tray theme is the
// IN-472 bug (white glyph invisible on a light taskbar). Colour correctness is
// pinned separately by `npm run verify:tray-icon`.
const iconFiles = [
  'resources/tray-icon-light.ico',
  'resources/tray-icon-dark.ico',
  'resources/tray-icon-light-rec.ico',
  'resources/tray-icon-dark-rec.ico'
]
const missingIcons = iconFiles.filter((p) => !fs.existsSync(p))
if (missingIcons.length > 0) {
  console.error('Icons missing: ' + missingIcons.join(', '))
  console.error('Run: node scripts/generate-tray-icons.cjs')
  process.exit(1)
}

// 4. Credentials file must exist (unless MN_ALLOW_STUB_PACKAGE=1).
if (!fs.existsSync(envFile)) {
  if (process.env.MN_ALLOW_STUB_PACKAGE === '1') {
    console.warn('MN_ALLOW_STUB_PACKAGE=1: proceeding without backend.env (stub-only build)')
  } else {
    console.error('Credentials file missing: ' + envFile)
    console.error('Create ' + envFile + ' with team keys, or set MN_ALLOW_STUB_PACKAGE=1 for stub builds.')
    process.exit(1)
  }
}

// 3. Copy credentials into the bundle staging dir so extraResources ships it.
if (fs.existsSync(envFile)) {
  const destDir = path.dirname(bundleEnvDest)
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(envFile, bundleEnvDest)
  console.log('Bundled credentials: ' + envFile + ' -> ' + bundleEnvDest)
}
