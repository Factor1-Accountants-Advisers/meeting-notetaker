import * as fs from 'fs';
import * as path from 'path';

describe('electron-builder backend packaging filters', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');

  it('excludes local secrets and generated backend artifacts from packaged resources', () => {
    expect(config).toContain('!**/.env');
    expect(config).toContain('!**/.env.*');
    expect(config).toContain('!**/__pycache__/**');
    expect(config).toContain('!**/*.pyc');
    expect(config).toContain('!**/.venv/**');
    expect(config).toContain('!**/venv/**');
  });

  it('builds NSIS assets suitable for public GitHub electron-updater releases', () => {
    expect(config).toContain('target: nsis');
    expect(config).toContain('provider: github');
    expect(config).toContain('repo: meeting-notetaker');
    expect(config).toContain('perMachine: false');
    expect(config).toContain('artifactName: "${productName} Setup ${version}.${ext}"');
    expect(config).not.toContain('target: msi');
    expect(config).not.toContain('private: true');
    expect(config).not.toContain('msiProjectCreated');
  });
});
