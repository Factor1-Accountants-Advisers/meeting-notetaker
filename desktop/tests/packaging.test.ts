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
});
