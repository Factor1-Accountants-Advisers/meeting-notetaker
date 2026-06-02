const mockShowMessageBox = jest.fn();
const mockOn = jest.fn();
const mockCheckForUpdates = jest.fn();
const mockQuitAndInstall = jest.fn();

jest.mock('electron', () => ({
  dialog: {
    showMessageBox: mockShowMessageBox,
  },
}));

jest.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    on: mockOn,
    checkForUpdates: mockCheckForUpdates,
    quitAndInstall: mockQuitAndInstall,
  },
}));

import { autoUpdater } from 'electron-updater';
import { initUpdater, resetUpdaterStateForTests } from '../src/main/updater';

type Handler = (...args: any[]) => void;

function handlerFor(eventName: string): Handler {
  const call = mockOn.mock.calls.find(([name]) => name === eventName);
  if (!call) throw new Error(`Missing handler for ${eventName}`);
  return call[1];
}

describe('prompt-only updater', () => {
  beforeEach(() => {
    resetUpdaterStateForTests();
    mockOn.mockClear();
    mockCheckForUpdates.mockClear();
    mockQuitAndInstall.mockClear();
    mockShowMessageBox.mockClear();
    mockCheckForUpdates.mockResolvedValue(undefined);
    mockShowMessageBox.mockResolvedValue({ response: 1 });
  });

  it('checks for updates without installing automatically', async () => {
    const controller = initUpdater({ isPackaged: true, isRecording: () => false, checkIntervalMs: 0 });

    await controller.checkForUpdates(true);

    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(mockQuitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdater.autoDownload).toBe(true);
  });

  it('prompts once when an update is downloaded and installs only when accepted', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    initUpdater({ isPackaged: true, isRecording: () => false, checkIntervalMs: 0 });

    await handlerFor('update-downloaded')({ version: '1.1.6' });
    await handlerFor('update-downloaded')({ version: '1.1.6' });

    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      buttons: ['Restart now', 'Later'],
    }));
    expect(mockQuitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('keeps the update pending when the user chooses Later', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 1 });
    const controller = initUpdater({ isPackaged: true, isRecording: () => false, checkIntervalMs: 0 });

    await handlerFor('update-downloaded')({ version: '1.1.6' });

    expect(mockQuitAndInstall).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ status: 'downloaded', downloaded: true, version: '1.1.6' });
  });

  it('blocks restart while recording', async () => {
    mockShowMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 });
    const controller = initUpdater({ isPackaged: true, isRecording: () => true, checkIntervalMs: 0 });

    await handlerFor('update-downloaded')({ version: '1.1.6' });
    const installed = await controller.installDownloadedUpdate();

    expect(installed).toBe(false);
    expect(mockQuitAndInstall).not.toHaveBeenCalled();
    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('Finish your recording first'),
    }));
  });

  it('shows useful manual feedback for no update and errors', async () => {
    const controller = initUpdater({ isPackaged: true, isRecording: () => false, checkIntervalMs: 0 });

    mockCheckForUpdates.mockImplementationOnce(async () => {
      handlerFor('update-not-available')({ version: '1.1.5' });
    });
    await controller.checkForUpdates(true);

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'info',
      message: expect.stringContaining('up to date'),
    }));

    mockCheckForUpdates.mockRejectedValueOnce(new Error('network failed'));
    await controller.checkForUpdates(true);

    expect(mockShowMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('failed'),
    }));
  });
});
