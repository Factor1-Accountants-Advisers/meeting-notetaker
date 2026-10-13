// Packaging policy check: local FD97 launchers/fixtures must not ship.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { minimatch } = require('minimatch');
const config = fs.readFileSync('electron-builder.yml', 'utf8');
const exclusions = config.split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*-\s*['"]!([^'"]+)['"]\s*$/);
  return match ? [match[1]] : [];
});
const included = name => !exclusions.some(pattern => minimatch(name, pattern, { dot: true }));
for (const name of ['dev-notetaker.cjs', 'out/Start Dev.cmd', 'fd97-test.cjs', 'fd97-processing-test.cjs', 'out/verify-prompted-call-recovery.cjs', 'out/verify-teams-call-prompt.cjs', 'scripts/fd97-live-backend.py', 'backend.env', 'recordings/private.webm']) {
  assert.equal(included(name), false, 'Test/private file must not ship: ' + name);
}
for (const name of ['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html']) {
  assert.equal(included(name), true, 'Production application file must remain: ' + name);
}
assert.match(config, /from: backend\/dist\/notetaker-backend/);
assert.match(config, /from: native\/audio-endpoint-monitor\/dist/);
console.log('FD97 packaging policy passed: local harnesses/fixtures excluded, production app/resources retained');
