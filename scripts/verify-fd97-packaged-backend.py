"""Run the actual frozen backend on an owned private port; no live providers."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = Path(os.environ.get('FD97_PACKAGE_ROOT', str(ROOT / 'dist/win-unpacked'))) / 'resources/backend'
EXE = BUNDLE / 'notetaker-backend.exe'
SCRATCH = Path(os.environ['TMPDIR']).resolve()
assert EXE.is_file()


def installed_state():
    output = subprocess.check_output(['netstat', '-ano', '-p', 'tcp'], text=True)
    listeners = sorted({int(parts[-1]) for line in output.splitlines()
                        if len(parts := line.split()) >= 5 and parts[1].endswith(':8787') and parts[-2] == 'LISTENING'})
    data = Path(os.environ['APPDATA']) / 'meeting-notetaker'
    hashes = {name: hashlib.sha256((data / name).read_bytes()).hexdigest()
              for name in ['backend-data/store.json', 'backend-data/voiceprints.json'] if (data / name).exists()}
    with urlopen('http://127.0.0.1:8787/health', timeout=5) as response:
        health = json.load(response)
    assert listeners and 'backend-data/store.json' in hashes, 'Installed comparison target missing'
    return {'listeners': listeners, 'hashes': hashes, 'health': health}


before = installed_state()
profile = Path(tempfile.mkdtemp(prefix='fd97-packaged-backend-', dir=SCRATCH))
(profile / 'FD97_SYNTHETIC_TEST.json').write_text('{"mode":"frozen-backend-private-port"}')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = {key: value for key, value in os.environ.items() if not key.startswith('MN_')}
env.update(MN_DATA_DIR=str(profile), MN_BACKEND_PORT=str(port), MN_BACKEND_HOST='127.0.0.1',
           MN_APP_VERSION='FD97-PACKAGE-SMOKE', MN_STORAGE_API_ENABLED='false',
           MN_STORAGE_API_URL='', MN_OPENAI_API_KEY='', MN_PYANNOTE_API_KEY='',
           MN_SHAREPOINT_DRIVE_ID='', MN_AZURE_STORAGE_CONNECTION_STRING='',
           TEMP=str(SCRATCH), TMP=str(SCRATCH), TMPDIR=str(SCRATCH))
log = (profile / 'backend.log').open('w', encoding='utf-8')
process = subprocess.Popen([str(EXE)], cwd=profile, env=env, stdout=log, stderr=subprocess.STDOUT)
base = 'http://127.0.0.1:' + str(port)


def request(method, route, body=None):
    data = json.dumps(body).encode() if body is not None else None
    with urlopen(Request(base + route, method=method, data=data, headers={'Content-Type': 'application/json', 'X-MN-User': 'Package fixture'}), timeout=10) as response:
        return json.load(response)


try:
    deadline = time.monotonic() + 30
    while True:
        assert process.poll() is None, 'Owned frozen backend exited; see ' + str(profile)
        try:
            health = request('GET', '/health')
            assert health['app_version'] == 'FD97-PACKAGE-SMOKE'
            break
        except OSError:
            assert time.monotonic() < deadline, 'Health deadline exceeded'
            time.sleep(0.2)
    meeting = request('POST', '/api/v1/meetings', {'title': 'SYNTHETIC packaged dual-track smoke', 'source': 'in_person'})
    mid = meeting['id']
    audio = base64.b64encode((ROOT / 'scripts/fixtures/smoke-silent.webm').read_bytes()).decode()
    request('POST', '/api/v1/meetings/' + mid + '/audio', {'audio_b64': audio, 'mime_type': 'audio/webm', 'system_audio_b64': audio, 'system_mime_type': 'audio/webm', 'duration_seconds': 1})
    deadline = time.monotonic() + 90
    while True:
        meeting = request('GET', '/api/v1/meetings/' + mid)
        if meeting['pipeline_status'] in ('ready', 'failed'):
            break
        assert time.monotonic() < deadline, 'Pipeline deadline exceeded'
        time.sleep(0.3)
    assert meeting['pipeline_status'] == 'ready', meeting.get('pipeline_error_message')
    assert meeting['recorder_audio_missing'] is True, 'Bundled ffmpeg did not flag the silent fixture'
    assert meeting['delivery_status'] == 'not_started', 'No delivery may be invoked by this smoke'
    assert meeting['invitee_delivery_status'] == 'not_started'
    for suffix in ('.webm', '.mic.webm', '.system.webm'):
        assert (profile / 'audio' / (mid + suffix)).is_file(), suffix
    report = {'mode': 'synthetic-input-actual-frozen-backend', 'private_port': port,
              'backend_executable': str(EXE), 'pipeline_status': meeting['pipeline_status'],
              'dual_tracks_saved': True, 'bundled_ffmpeg_executed': True,
              'delivery_not_invoked': True, 'provider_mode': 'credential-disabled-local-stubs',
              'data_directory': str(profile)}
finally:
    if process.poll() is None:
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    process.wait(timeout=15)
    log.close()
assert installed_state() == before, 'Installed listener, health or protected store changed'
report['installed_backend_and_store_unchanged'] = True
(profile / 'result.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
