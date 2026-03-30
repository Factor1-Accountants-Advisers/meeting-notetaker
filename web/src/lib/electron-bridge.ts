import type { CalendarEvent } from "@/types";

// --- Recording types ---

export interface RecordingOptions {
  micName: string;
  loopbackName: string;
  outputPath: string;
  meetingTitle?: string;
  metadata?: MeetingMetadata;
}

export interface RecordingStatus {
  recording: boolean;
  meetingTitle?: string;
  startedAt?: number;
}

export interface AudioDevice {
  name: string;
  id: string;
}

export interface MeetingMetadata {
  meeting_title: string;
  attendees: { name: string; email?: string }[];
  scheduled_time?: string;
}

export interface UploadArgs {
  filePath: string;
  metadata: MeetingMetadata;
}

export interface UploadResult {
  meeting_id: number;
  status: string;
}

// --- Electron API interface ---

export interface ElectronAPI {
  // Auth (existing)
  getToken: () => Promise<string>;
  signOut: () => Promise<void>;
  getBackendUrl: () => Promise<string>;
  getAppVersion: () => string;
  isElectron: true;

  // Calendar
  getCalendar: () => Promise<CalendarEvent[]>;

  // Recording
  startRecording: (opts: RecordingOptions) => Promise<void>;
  stopRecording: () => Promise<string>;
  isRecording: () => Promise<boolean>;
  getRecordingStatus: () => Promise<RecordingStatus>;
  onRecordingStatus: (cb: (status: RecordingStatus) => void) => () => void;

  // Upload via main process
  uploadRecording: (args: UploadArgs) => Promise<UploadResult>;

  // Meeting metadata
  selectMeeting: (event: CalendarEvent) => Promise<void>;

  // Audio devices
  getAudioDevices: () => Promise<AudioDevice[]>;
  getDefaultAudioDevices: () => Promise<{ micName: string; loopbackName: string }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// --- Accessors ---

/**
 * Returns true when running inside Electron (preload-web.ts injected the bridge).
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI?.isElectron;
}

/**
 * Get the Electron API. Throws if not running in Electron.
 * Use this in code paths that MUST be in Electron (e.g., useAuth).
 */
export function getElectronAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error("electronAPI not available — not running in Electron");
  }
  return window.electronAPI;
}

/**
 * Safe, non-throwing accessor. Returns undefined in browser.
 * Caches the reference for stable React dependency identity.
 * Use this in components that conditionally render Electron features.
 */
let _cachedApi: ElectronAPI | undefined;
let _resolved = false;

export function getElectronAPIOrNull(): ElectronAPI | undefined {
  if (!_resolved) {
    _resolved = true;
    if (typeof window !== "undefined" && window.electronAPI?.isElectron) {
      _cachedApi = window.electronAPI;
    }
  }
  return _cachedApi;
}
