import { acquireToken, acquireIdToken, signIn, clearTokenCache } from '../src/main/auth';

const mockAcquireTokenSilent = jest.fn();
const mockAcquireTokenInteractive = jest.fn();
const mockSerialize = jest.fn().mockReturnValue('serialized-cache');
const mockDeserialize = jest.fn();
const mockGetAllAccounts = jest.fn().mockResolvedValue([{ homeAccountId: 'acc1' }]);

jest.mock('@azure/msal-node', () => ({
  PublicClientApplication: jest.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenInteractive: mockAcquireTokenInteractive,
    getTokenCache: jest.fn().mockReturnValue({
      serialize: mockSerialize,
      deserialize: mockDeserialize,
      getAllAccounts: mockGetAllAccounts,
    }),
  })),
  LogLevel: { Warning: 2 },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue(Buffer.from('enc:cached-data')),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

process.env.AZURE_AD_CLIENT_ID = 'test-client-id';
process.env.AZURE_AD_TENANT_ID = 'test-tenant-id';

function makeJwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp, name: 'Test User', preferred_username: 'test@example.com' })}.sig`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquireTokenSilent.mockReset();
  mockAcquireTokenInteractive.mockReset();
  mockGetAllAccounts.mockReset().mockResolvedValue([{ homeAccountId: 'acc1' }]);
});

describe('auth.acquireToken', () => {
  it('returns access token on silent success', async () => {
    mockAcquireTokenSilent.mockResolvedValueOnce({ accessToken: 'token-abc' });
    expect(await acquireToken()).toBe('token-abc');
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('throws when no cached accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValueOnce([]);
    await expect(acquireToken()).rejects.toThrow('No cached accounts');
  });
});

describe('auth.acquireIdToken', () => {
  it('returns id token on silent success', async () => {
    mockAcquireTokenSilent.mockResolvedValueOnce({ idToken: makeJwt(Math.floor(Date.now() / 1000) + 3600) });
    expect(await acquireIdToken()).toContain('.');
  });

  it('force-refreshes when silent cache returns an expired id token', async () => {
    const expired = makeJwt(Math.floor(Date.now() / 1000) - 60);
    const fresh = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    mockAcquireTokenSilent
      .mockResolvedValueOnce({ idToken: expired })
      .mockResolvedValueOnce({ idToken: fresh });

    expect(await acquireIdToken()).toBe(fresh);
    expect(mockAcquireTokenSilent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it('throws when no cached accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValueOnce([]);
    await expect(acquireIdToken()).rejects.toThrow('No cached accounts');
  });
});

describe('auth.signIn', () => {
  it('returns cached id token silently if available', async () => {
    const cached = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    mockAcquireTokenSilent.mockResolvedValueOnce({ idToken: cached });
    expect(await signIn()).toBe(cached);
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('falls back to interactive when silent fails', async () => {
    mockGetAllAccounts.mockResolvedValueOnce([]);
    mockAcquireTokenInteractive.mockResolvedValueOnce({ idToken: 'interactive-id' });
    expect(await signIn()).toBe('interactive-id');
    expect(mockAcquireTokenInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: expect.arrayContaining(['openid', 'profile', 'offline_access']),
        openBrowser: expect.any(Function),
        successTemplate: expect.stringContaining('Sign-in successful'),
        errorTemplate: expect.stringContaining('Sign-in failed'),
      }),
    );
  });

  it('throws when interactive also fails', async () => {
    mockGetAllAccounts.mockResolvedValueOnce([]);
    mockAcquireTokenInteractive.mockRejectedValueOnce(new Error('user_cancelled'));
    await expect(signIn()).rejects.toThrow('user_cancelled');
  });
});

describe('auth.clearTokenCache', () => {
  it('attempts to delete the cache file', async () => {
    const fs = require('fs');
    await clearTokenCache();
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});
