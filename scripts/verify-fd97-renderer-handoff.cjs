// Real built renderer/preload integration; every backend/auth reply is a fixture.
// No production main, provider network, microphone, protocol or installed state.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.FD97_APP_ROOT || path.join(__dirname, '..'));
const scratch = path.resolve(process.env.TMPDIR || process.env.RUNNER_TEMP || '');
const allowedLocal = process.env.TMPDIR && scratch.toLowerCase().includes('hermes');
const allowedCi = process.env.CI === 'true' && process.env.RUNNER_TEMP && scratch === path.resolve(process.env.RUNNER_TEMP);
if (!allowedLocal && !allowedCi) throw new Error('Hermes scratch directory or isolated CI runner temp required');
const profile = fs.mkdtempSync(path.join(scratch, 'fd97-handoff-'));
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.setName('FD97 synthetic handoff check');
app.on('window-all-closed', () => {}); // Multiple renderer-restart scenarios share this fixture process.
const mid = '11111111-1111-4111-8111-111111111111';
const participant = { name: 'Synthetic participant', email: 'fixture-participant@factor1.com.au' };
const now = Date.now();
const original = {
  id: mid, title: 'SYNTHETIC delayed-call handoff', source: 'online', status: 'draft',
  owner_id: 'Fixture Recorder', created_at: new Date(now - 180000).toISOString(), duration_seconds: 120,
  pipeline_status: 'ready', pipeline_error_message: null, blob_status: 'uploaded',
  delivery_status: 'emailed', delivery_recipients: ['recorder@factor1.com.au'],
  delivery_emailed_at: new Date(now - 30000).toISOString(), invitee_delivery_status: 'not_started',
  call_lookup_status: 'pending', call_lookup_next_retry_at: null,
  graph_metadata: { attendees: [], prompted_call: { nonce: 'synthetic-nonce', observed_start_utc: new Date(now - 180000).toISOString(), observed_end_utc: new Date(now - 60000).toISOString() } },
  unknown_speaker_count: 1, action_item_count: 0,
};
let meeting, decision, ready, enabled, calls = [], prompts = [];
const persist = () => fs.writeFileSync(path.join(profile, 'synthetic-state.json'), JSON.stringify({ meeting, decision }));
function reset(status = 'not_started', answer = 'pending', resolved = false, promptEnabled = true) {
  meeting = structuredClone(original); meeting.invitee_delivery_status = status;
  meeting.call_lookup_status = resolved ? 'resolved' : 'pending';
  if (resolved) meeting.graph_metadata.attendees = [participant];
  decision = answer; ready = resolved; enabled = promptEnabled; calls = []; prompts = []; persist();
}
const envelope = body => ({ ok: true, status: 200, body: structuredClone(body) });
const invokeChannels = ['app:version', 'auth:status', 'auth:storage-admin-status', 'recording:spill-list', 'recording:list-saved', 'audio-endpoints:get', 'startup:get-auto-launch', 'updates:check'];
for (const channel of invokeChannels) ipcMain.handle(channel, () => {
  if (channel === 'auth:status') return { signedIn: true, email: 'recorder@factor1.com.au', name: 'Fixture Recorder' };
  if (channel === 'auth:storage-admin-status') return { isAdmin: false };
  if (channel === 'app:version') return 'FD97-SYNTHETIC-TEST';
  if (channel.includes('list')) return [];
  return null;
});
ipcMain.on('delivery:prompt-invitees', (_event, request) => prompts.push(request));
ipcMain.handle('api:request', (_event, request) => {
  const { method, path: url, body } = request; calls.push({ method, path: url });
  if (url.includes('/enrolment-status')) return envelope({ enrolled_locally: true, centrally_enrolled: true, central_required: true, centrally_unknown: false });
  if (url === '/api/v1/people/me') return envelope({ employee_id: 'synthetic-recorder', display_name: 'Fixture Recorder', email: 'recorder@factor1.com.au', role: 'Staff', enrolled: true });
  if (url === '/api/v1/meetings') return envelope([meeting]);
  if (url.includes('/call-participants/resolve')) {
    if (ready) { meeting.call_lookup_status = 'resolved'; meeting.graph_metadata.attendees = [participant]; }
    persist(); return envelope(meeting);
  }
  if (url.includes('/invitees/decision')) { decision = body.approved ? 'approved' : 'declined'; persist(); return envelope(meeting); }
  if (url.includes('/invitees')) return envelope({ prompt_enabled: enabled, decision, invitee_delivery_status: meeting.invitee_delivery_status, candidates: meeting.call_lookup_status === 'resolved' ? [participant] : [], organizer_recipients: ['recorder@factor1.com.au'] });
  if (url.endsWith('/sharepoint')) { meeting.sharepoint_web_url = 'file:///synthetic-notes.md'; persist(); return envelope(meeting); }
  if (url.endsWith('/email')) {
    assert.equal(decision, 'approved', 'No delivery pass before explicit/durable approval');
    assert.equal(meeting.invitee_delivery_status, 'not_started');
    meeting.invitee_delivery_status = 'sent'; persist();
    return envelope({ recipients: [participant.email], sent_now: [participant.email], emailed_at: new Date().toISOString() });
  }
  if (url === '/api/v1/meetings/' + mid) return envelope(meeting);
  if (method !== 'GET') throw new Error('Unexpected mutation: ' + url);
  return envelope([]);
});
const count = suffix => calls.filter(c => c.method === 'POST' && c.path.endsWith(suffix)).length;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await wait(100); }
  throw new Error('Timed out: ' + label);
}
async function open(partition) {
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'out/preload/index.mjs'), contextIsolation: true, sandbox: false, partition } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.error('Renderer:', message); });
  await win.loadFile(path.join(root, 'out/renderer/index.html'));
  try {
    await until(() => calls.filter(c => c.path === '/api/v1/meetings').length >= 2, 'real renderer hydration');
  } catch (error) {
    console.error(JSON.stringify({ calls, dom: await win.webContents.executeJavaScript('document.body.innerText') }));
    throw error;
  }
  return win;
}
app.whenReady().then(async () => {
  const checks = [];
  reset();
  let win = await open('persist:fd97-pending');
  assert.equal(count('/email'), 0); assert.equal(prompts.length, 0);
  await until(() => count('/call-participants/resolve') === 1, 'pending lookup');
  ready = true;
  win.reload();
  await until(() => prompts.length === 1, 'late participant reaches existing approval prompt');
  assert.equal(count('/email'), 0);
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  assert.match(text, /SYNTHETIC delayed-call handoff/);
  assert.match(text, /invitees|participants/i);
  win.webContents.send('delivery:invitee-decision', { meetingId: mid, approved: true, source: 'app' });
  await until(() => meeting.invitee_delivery_status === 'sent', 'existing delivery pass');
  assert.equal(count('/sharepoint'), 1); assert.equal(count('/email'), 1);
  assert.deepEqual(meeting.delivery_recipients, original.delivery_recipients);
  assert.equal(meeting.delivery_emailed_at, original.delivery_emailed_at);
  checks.push('pending → resolved → existing approval prompt → existing delivery pass, recorder fields unchanged');
  win.destroy();
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'synthetic-state.json'))); meeting = saved.meeting; decision = saved.decision;
  win = await open('persist:fd97-pending'); await wait(600);
  assert.equal(count('/email'), 1); win.destroy();
  checks.push('renderer restart after sent does not repeat delivery');
  reset('not_started', 'approved', true);
  win = await open('persist:fd97-approved');
  await until(() => count('/email') === 1, 'durable approved recovery');
  assert.equal(count('/sharepoint'), 1); assert.equal(prompts.length, 0); win.destroy();
  checks.push('durable approved/not_started resumes the same delivery pass without another prompt');
  for (const status of ['sending', 'sent', 'failed', 'unconfirmed']) {
    reset(status, 'approved', true);
    win = await open('persist:fd97-' + status); await wait(600);
    assert.equal(count('/email'), 0); assert.equal(count('/sharepoint'), 0); win.destroy();
    checks.push(status + ' does not automatically resend');
  }
  reset('not_started', 'approved', true, false);
  win = await open('persist:fd97-disabled'); await wait(600); assert.equal(count('/email'), 0); win.destroy();
  checks.push('recipient-policy kill switch remains authoritative');
  reset('not_started', 'declined', true);
  win = await open('persist:fd97-declined'); await wait(600);
  assert.equal(count('/email'), 0); assert.equal(prompts.length, 0); win.destroy();
  checks.push('declined approval is neither resurfaced nor delivered');
  const report = { verifiedAt: new Date().toISOString(), profile, mode: 'synthetic-renderer-contract', realBuiltRendererAndPreload: true, providerRequests: 0, checks };
  fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
setTimeout(() => { console.error('Handoff fixture exceeded 60s'); app.exit(1); }, 60000);
