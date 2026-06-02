import * as fs from 'fs';
import * as path from 'path';

describe('electron-builder backend packaging filters', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const nsisIncludePath = path.join(__dirname, '..', 'build', 'installer.nsh');

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
    expect(config).toContain('oneClick: true');
    expect(config).toContain('perMachine: false');
    expect(config).toContain('artifactName: "${productName} Setup ${version}.${ext}"');
    expect(config).not.toContain('target: msi');
    expect(config).not.toContain('private: true');
    expect(config).not.toContain('msiProjectCreated');
  });

  it('uses a custom NSIS remove hook to avoid slow old-install moves during updates', () => {
    expect(fs.existsSync(nsisIncludePath)).toBe(true);
    const nsisInclude = fs.readFileSync(nsisIncludePath, 'utf8');

    expect(nsisInclude).toContain('!macro customRemoveFiles');
    expect(nsisInclude).toContain('${isUpdated}');
    expect(nsisInclude).toContain('RMDir /r "$INSTDIR"');
    expect(nsisInclude).not.toContain('old-install');
  });
});
