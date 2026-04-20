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

describe('auth.acquireToken', () => {
  beforeEach(() => jest.clearAllMocks());

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
  beforeEach(() => jest.clearAllMocks());

  it('returns id token on silent success', async () => {
    mockAcquireTokenSilent.mockResolvedValueOnce({ idToken: 'id-token-abc' });
    expect(await acquireIdToken()).toBe('id-token-abc');
  });

  it('throws when no cached accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValueOnce([]);
    await expect(acquireIdToken()).rejects.toThrow('No cached accounts');
  });
});

describe('auth.signIn', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns cached id token silently if available', async () => {
    mockAcquireTokenSilent.mockResolvedValueOnce({ idToken: 'cached-id' });
    expect(await signIn()).toBe('cached-id');
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
