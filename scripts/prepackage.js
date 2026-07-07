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

// 2. Credentials file must exist (unless MN_ALLOW_STUB_PACKAGE=1).
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
