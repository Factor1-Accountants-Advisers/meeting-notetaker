jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:/Users/Test/AppData/Roaming/meeting-notetaker-desktop'),
  },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBackendEnv, loadRuntimeOverrideEnv, stopProcessTreeForWindows } from '../src/main/backend-runtime';

describe('backend-runtime environment loading', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ASSEMBLYAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-runtime-env-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads AI provider keys from the per-user runtime override file', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env.production.local'),
      'ASSEMBLYAI_API_KEY=assembly-test-key\nOPENAI_API_KEY=openai-test-key\nIGNORED_KEY=ignored\n',
      'utf8',
    );

    expect(loadRuntimeOverrideEnv(tempDir)).toEqual({
      ASSEMBLYAI_API_KEY: 'assembly-test-key',
      OPENAI_API_KEY: 'openai-test-key',
    });
  });

  it('passes runtime AI provider keys into the spawned backend env', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env.production.local'),
      'ASSEMBLYAI_API_KEY=assembly-test-key\nOPENAI_API_KEY=openai-test-key\n',
      'utf8',
    );

    const env = buildBackendEnv('C:/Users/Test/AppData/Roaming/meeting-notetaker-desktop/backend-data', tempDir);

    expect(env.ASSEMBLYAI_API_KEY).toBe('assembly-test-key');
    expect(env.OPENAI_API_KEY).toBe('openai-test-key');
    expect(env.DATABASE_URL).toContain('meetings.db');
    expect(env.STORAGE_BACKEND).toBe('local');
  });

  it('uses taskkill to stop a backend process tree on Windows update shutdown', () => {
    const run = jest.fn(() => ({ status: 0, error: undefined, stderr: '' }));

    stopProcessTreeForWindows(1234, run as any);

    expect(run).toHaveBeenCalledWith('taskkill.exe', ['/PID', '1234', '/T', '/F'], expect.objectContaining({
      windowsHide: true,
      encoding: 'utf8',
    }));
  });
});
