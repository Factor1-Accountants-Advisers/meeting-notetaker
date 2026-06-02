jest.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: jest.fn(() => '/tmp/notetaker-runtime-user-data'),
  },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePackagedPythonRuntime, getPythonPath } from '../src/main/runtime-paths';

describe('runtime paths', () => {
  const originalResourcesPath = process.resourcesPath;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-runtime-paths-'));
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join(tempDir, 'resources'),
      configurable: true,
    });
    fs.mkdirSync(process.resourcesPath, { recursive: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    });
    fs.rmSync('/tmp/notetaker-runtime-user-data', { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the per-user extracted Python runtime path in packaged mode', () => {
    expect(getPythonPath()).toBe('/tmp/notetaker-runtime-user-data/python-runtime/python.exe');
  });

  it('extracts packaged Python archive when python.exe is missing', () => {
    fs.writeFileSync(path.join(process.resourcesPath, 'python-runtime.zip'), 'zip-placeholder');
    const run = jest.fn(() => {
      const pythonExe = '/tmp/notetaker-runtime-user-data/python-runtime/python.exe';
      fs.mkdirSync(path.dirname(pythonExe), { recursive: true });
      fs.writeFileSync(pythonExe, 'python');
      return { status: 0, stderr: '', error: undefined };
    });

    ensurePackagedPythonRuntime(run as any);

    expect(run).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
    ]), expect.objectContaining({ windowsHide: true, encoding: 'utf8' }));
  });
});
