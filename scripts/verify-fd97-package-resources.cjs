// Inspect the actual packaged ASAR/resources without starting production main.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(process.env.FD97_PACKAGE_ROOT || 'dist/win-unpacked');
const archive = path.join(root, 'resources/app.asar');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entries = asar.listPackage(archive).map(name => name.split(String.fromCharCode(92)).join('/').replace(/^\/+/, ''));
const forbidden = entries.filter(name => name.startsWith('scripts/') || name.startsWith('out/verify-') || name.startsWith('recordings/') || name === 'backend.env' || name === 'dev-notetaker.cjs' || name === 'out/Start Dev.cmd' || /^fd97-.*\.cjs$/.test(name));
assert.deepEqual(forbidden, [], 'Local harness/data files must not ship');
for (const file of ['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html']) {
  assert.equal(hash(asar.extractFile(archive, path.normalize(file))), hash(fs.readFileSync(file)), 'Stale packaged application file: ' + file);
}
for (const pair of [
  ['resources/backend/notetaker-backend.exe', 'backend/dist/notetaker-backend/notetaker-backend.exe'],
  ['resources/backend/_internal/ffmpeg/ffmpeg.exe', 'backend/third_party/ffmpeg/ffmpeg.exe'],
  ['resources/audio/notetaker-audio-endpoints.exe', 'native/audio-endpoint-monitor/dist/notetaker-audio-endpoints.exe'],
]) assert.equal(hash(fs.readFileSync(path.join(root, pair[0]))), hash(fs.readFileSync(pair[1])), 'Stale resource: ' + pair[0]);
assert.equal(hash(fs.readFileSync(path.join(root, 'resources/backend/backend.env'))), hash(fs.readFileSync('backend.env')), 'Credential staging mismatch');
const report = { archive, builtApplicationFilesMatch: true, packagedBackendHelperFfmpegMatch: true, localTestAndPrivateFilesExcluded: true, credentialStagingVerifiedWithoutPrintingValues: true };
console.log(JSON.stringify(report, null, 2));
