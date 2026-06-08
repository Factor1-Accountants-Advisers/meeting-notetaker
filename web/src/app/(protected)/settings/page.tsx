"use client";

import { useState, useEffect } from "react";
import { Mic, Volume2, AlertTriangle, Info, LogOut, ShieldCheck, Upload, Trash2, Ban } from "lucide-react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import type { AudioDevice } from "@/lib/electron-bridge";
import {
  readAudioSettings,
  saveAudioSettings,
  hasCompleteAudioSettings,
  needsDefaultAudioSettings,
  applyDefaultAudioSettings,
} from "@/lib/audio-settings";
import {
  deleteVoiceprint,
  disableVoiceprint,
  uploadVoiceprintSample,
  useVoiceprints,
} from "@/lib/api";

export default function SettingsPage() {
  const api = getElectronAPIOrNull();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [micName, setMicName] = useState("");
  const [loopbackName, setLoopbackName] = useState("");
  const [backendUrl, setBackendUrl] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [saved, setSaved] = useState(false);
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null);
  const [voiceSample, setVoiceSample] = useState<File | null>(null);
  const [voiceprintBusy, setVoiceprintBusy] = useState(false);
  const [voiceprintError, setVoiceprintError] = useState<string | null>(null);
  const [voiceprintNotice, setVoiceprintNotice] = useState<string | null>(null);
  const { data: voiceprints, mutate: refreshVoiceprints, isLoading: voiceprintsLoading } = useVoiceprints();

  useEffect(() => {
    if (!api) return;

    api
      .getAudioDevices()
      .then(async (results) => {
        setDevices(results);
        setDeviceLoadError(
          results.length === 0
            ? "No audio devices were detected. Check your Windows audio settings, then reopen this page."
            : null
        );

        // Auto-apply system defaults on first launch
        if (needsDefaultAudioSettings() && results.length > 0) {
          try {
            const defaults = await api.getDefaultAudioDevices();
            const applied = applyDefaultAudioSettings(defaults);
            if (applied) {
              setMicName(applied.micName);
              setLoopbackName(applied.loopbackName);
              return;
            }
          } catch {
            // Fall through to load saved settings
          }
        }

        // Load saved preferences
        const savedSettings = readAudioSettings();
        setMicName(savedSettings.micName);
        setLoopbackName(savedSettings.loopbackName);
      })
      .catch(() => {
        setDeviceLoadError(
          "We couldn't load your audio devices. Check that the app has access to your audio devices, then try again."
        );
      });

    api.getBackendUrl().then(setBackendUrl);
    setAppVersion(api.getAppVersion());
  }, [api]);

  const handleSave = () => {
    saveAudioSettings({ micName, loopbackName });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSignOut = async () => {
    if (!api) return;
    await api.signOut();
    window.location.reload();
  };

  const activeVoiceprints = (voiceprints?.items ?? []).filter((item) => item.status === "active");
  const latestVoiceprint = voiceprints?.items?.[0];

  const handleVoiceprintUpload = async () => {
    if (!voiceSample) return;
    setVoiceprintBusy(true);
    setVoiceprintError(null);
    setVoiceprintNotice(null);
    try {
      await uploadVoiceprintSample(voiceSample);
      setVoiceSample(null);
      setVoiceprintNotice("Voice ID sample uploaded. Future meetings can use it for speaker identification.");
      await refreshVoiceprints();
    } catch (err) {
      setVoiceprintError(err instanceof Error ? err.message : "Voice ID upload failed");
    } finally {
      setVoiceprintBusy(false);
    }
  };

  const handleDisableVoiceprint = async (id: number) => {
    setVoiceprintBusy(true);
    setVoiceprintError(null);
    setVoiceprintNotice(null);
    try {
      await disableVoiceprint(id);
      setVoiceprintNotice("Voice ID disabled. It will not be used for future meetings.");
      await refreshVoiceprints();
    } catch (err) {
      setVoiceprintError(err instanceof Error ? err.message : "Failed to disable Voice ID");
    } finally {
      setVoiceprintBusy(false);
    }
  };

  const handleDeleteVoiceprint = async (id: number) => {
    setVoiceprintBusy(true);
    setVoiceprintError(null);
    setVoiceprintNotice(null);
    try {
      await deleteVoiceprint(id);
      setVoiceprintNotice("Voice ID deleted from future speaker matching.");
      await refreshVoiceprints();
    } catch (err) {
      setVoiceprintError(err instanceof Error ? err.message : "Failed to delete Voice ID");
    } finally {
      setVoiceprintBusy(false);
    }
  };

  const audioReady = hasCompleteAudioSettings({ micName, loopbackName });

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto pr-2">
      <div className="surface-card rounded-[34px] px-8 py-8 shadow-[var(--shadow-panel)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
          Settings
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[color:var(--text-primary)]">
          Audio Setup
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-[color:var(--text-secondary)]">
          Before recording, choose the microphone that captures your voice and
          the system audio source that captures your Teams meeting.
        </p>

        {!api ? (
          <div className="mt-8 rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] p-6">
            <p className="text-sm text-[color:var(--text-secondary)]">
              Audio setup is available when the app is running inside Electron.
            </p>
          </div>
        ) : (
          <section className="mt-8 rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] p-6">
            <div className="space-y-6">
              {!audioReady && (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />
                  <div>
                    <p className="text-sm font-medium text-[color:var(--text-primary)]">
                      Choose both audio sources before recording.
                    </p>
                    <p className="mt-1 text-xs leading-6 text-[color:var(--text-secondary)]">
                      This only needs to be configured once on this device.
                    </p>
                  </div>
                </div>
              )}

              {deviceLoadError && (
                <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-4 py-3">
                  <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-[color:var(--text-secondary)]" />
                  <p className="text-sm leading-6 text-[color:var(--text-secondary)]">
                    {deviceLoadError}
                  </p>
                </div>
              )}

              <div>
                <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
                  Microphone
                </label>
                <p className="mb-3 text-sm text-[color:var(--text-secondary)]">
                  Choose the microphone that captures your voice during the meeting.
                </p>
                <div className="relative">
                  <Mic className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)]" />
                  <select
                    value={micName}
                    onChange={(e) => setMicName(e.target.value)}
                    className="h-12 w-full appearance-none rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] pl-11 pr-4 text-sm text-[color:var(--text-primary)] outline-none transition focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
                  >
                    <option value="">Choose a microphone</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.name}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
                  System Audio
                </label>
                <p className="mb-3 text-sm text-[color:var(--text-secondary)]">
                  Choose the audio source that captures Teams or your computer audio.
                </p>
                <div className="relative">
                  <Volume2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)]" />
                  <select
                    value={loopbackName}
                    onChange={(e) => setLoopbackName(e.target.value)}
                    className="h-12 w-full appearance-none rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] pl-11 pr-4 text-sm text-[color:var(--text-primary)] outline-none transition focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
                  >
                    <option value="">Choose system audio</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.name}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 border-t border-[color:var(--border-subtle)] pt-5">
                <p className="text-sm text-[color:var(--text-secondary)]">
                  {saved
                    ? "Your audio setup has been saved."
                    : "Save once, then return to the dashboard to record."}
                </p>
                <button
                  onClick={handleSave}
                  disabled={!audioReady}
                  className="inline-flex h-12 items-center rounded-full bg-[color:var(--surface-inverse)] px-6 text-sm font-medium text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saved ? "Saved" : "Save audio setup"}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="mt-8 rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
                Voice ID
              </h2>
              <p className="mt-1 text-sm leading-6 text-[color:var(--text-secondary)]">
                Upload a clean 20–30 second sample of only your voice. The raw sample is used to create a pyannote voiceprint, then the backend deletes the temporary audio file.
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 py-3 text-sm">
            {voiceprintsLoading ? (
              <p className="text-[color:var(--text-secondary)]">Loading Voice ID status...</p>
            ) : activeVoiceprints.length > 0 ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-[color:var(--text-primary)]">Voice ID active</p>
                  <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                    {activeVoiceprints.length} active sample{activeVoiceprints.length === 1 ? "" : "s"}. Latest update: {new Date(latestVoiceprint?.updated_at ?? activeVoiceprints[0].updated_at).toLocaleDateString()}.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDisableVoiceprint(activeVoiceprints[0].id)}
                    disabled={voiceprintBusy}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-[color:var(--border-subtle)] px-4 text-xs font-medium text-[color:var(--text-secondary)] transition hover:bg-[color:var(--surface-elevated)] disabled:opacity-50"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Disable
                  </button>
                  <button
                    onClick={() => handleDeleteVoiceprint(activeVoiceprints[0].id)}
                    disabled={voiceprintBusy}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-red-500/20 bg-red-500/5 px-4 text-xs font-medium text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[color:var(--text-secondary)]">
                No active Voice ID yet. Upload a sample before relying on automatic speaker identification.
              </p>
            )}
          </div>

          <div className="mt-5 space-y-3">
            <label className="block text-sm font-semibold text-[color:var(--text-primary)]">
              Upload voice sample
            </label>
            <input
              type="file"
              accept="audio/*,.m4a,.wav,.mp3"
              onChange={(event) => setVoiceSample(event.target.files?.[0] ?? null)}
              className="block w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-4 py-3 text-sm text-[color:var(--text-primary)] file:mr-4 file:rounded-full file:border-0 file:bg-[color:var(--surface-inverse)] file:px-4 file:py-2 file:text-sm file:font-medium file:text-[color:var(--text-inverse)]"
            />
            <p className="text-xs leading-5 text-[color:var(--text-secondary)]">
              Best result: quiet room, normal meeting microphone, no other voices, 20–30 seconds. You consent to using this sample to create your internal Voice ID.
            </p>
            {voiceprintError && (
              <p className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-300">
                {voiceprintError}
              </p>
            )}
            {voiceprintNotice && (
              <p className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
                {voiceprintNotice}
              </p>
            )}
            <button
              onClick={handleVoiceprintUpload}
              disabled={!voiceSample || voiceprintBusy}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-[color:var(--surface-inverse)] px-5 text-sm font-medium text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {voiceprintBusy ? "Processing..." : "Create Voice ID"}
            </button>
          </div>
        </section>

        <section className="mt-8 rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-6 py-5">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            About
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            {appVersion && (
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">App Version</dt>
                <dd className="text-[color:var(--text-primary)]">{appVersion}</dd>
              </div>
            )}
            {backendUrl && (
              <div className="flex items-start justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">Backend URL</dt>
                <dd className="break-all font-mono text-xs text-[color:var(--text-primary)]">
                  {backendUrl}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section className="mt-6 flex justify-start">
          <button
            onClick={handleSignOut}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-red-500/20 bg-red-500/5 px-5 text-sm font-medium text-red-600 transition hover:bg-red-500/10 dark:text-red-300"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </section>
      </div>
    </div>
  );
}
