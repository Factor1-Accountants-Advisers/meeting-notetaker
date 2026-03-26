import { acquireToken, clearTokenCache } from '../src/main/auth';

const mockAcquireTokenSilent = jest.fn();
const mockAcquireTokenByDeviceCode = jest.fn();
const mockSerialize = jest.fn().mockReturnValue('serialized-cache');
const mockDeserialize = jest.fn();
const mockGetAllAccounts = jest.fn().mockResolvedValue([{ homeAccountId: 'acc1' }]);

jest.mock('@azure/msal-node', () => ({
  PublicClientApplication: jest.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenByDeviceCode: mockAcquireTokenByDeviceCode,
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
    expect(mockAcquireTokenByDeviceCode).not.toHaveBeenCalled();
  });

  it('falls back to device code when silent throws', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('no_account'));
    mockAcquireTokenByDeviceCode.mockImplementation(async ({ deviceCodeCallback }: any) => {
      deviceCodeCallback({ message: 'Go to https://microsoft.com/devicelogin' });
      return { accessToken: 'token-device' };
    });
    expect(await acquireToken()).toBe('token-device');
  });

  it('throws when device code also fails', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('silent_fail'));
    mockAcquireTokenByDeviceCode.mockRejectedValueOnce(new Error('device_fail'));
    await expect(acquireToken()).rejects.toThrow('device_fail');
  });
});

describe('auth.clearTokenCache', () => {
  it('attempts to delete the cache file', async () => {
    const fs = require('fs');
    await clearTokenCache();
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});
