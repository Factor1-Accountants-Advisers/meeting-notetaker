const mockProtocolHandle = jest.fn();
const mockNetFetch = jest.fn();

jest.mock('electron', () => ({
  protocol: {
    handle: mockProtocolHandle,
  },
  net: {
    fetch: mockNetFetch,
  },
}));

function loadProtocolModule() {
  jest.resetModules();
  return require('../src/main/protocol') as typeof import('../src/main/protocol');
}

describe('app protocol API proxy', () => {
  beforeEach(() => {
    mockProtocolHandle.mockReset();
    mockNetFetch.mockReset();
    mockNetFetch.mockResolvedValue(new Response('ok'));
  });

  it('adds duplex half when proxying API requests with a request body', async () => {
    const { registerAppProtocol } = loadProtocolModule();
    registerAppProtocol('/static', 'http://127.0.0.1:38742');

    const handler = mockProtocolHandle.mock.calls[0][1];
    await handler(
      new Request('app://renderer/api/speaker-mappings', {
        method: 'POST',
        body: JSON.stringify({ speaker_label: 'SPEAKER_00' }),
        headers: { 'content-type': 'application/json' },
      })
    );

    expect(mockNetFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:38742/api/speaker-mappings',
      expect.objectContaining({
        method: 'POST',
        duplex: 'half',
      })
    );
  });

  it('does not add duplex when proxying bodyless API requests', async () => {
    const { registerAppProtocol } = loadProtocolModule();
    registerAppProtocol('/static', 'http://127.0.0.1:38742');

    const handler = mockProtocolHandle.mock.calls[0][1];
    await handler(new Request('app://renderer/api/meetings?page=1'));

    expect(mockNetFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:38742/api/meetings?page=1',
      expect.not.objectContaining({ duplex: 'half' })
    );
  });
});
