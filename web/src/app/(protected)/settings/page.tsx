"use client";

import { useState, useEffect } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import type { AudioDevice } from "@/lib/electron-bridge";

export default function SettingsPage() {
  const api = getElectronAPIOrNull();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [micName, setMicName] = useState("");
  const [loopbackName, setLoopbackName] = useState("");
  const [backendUrl, setBackendUrl] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.getAudioDevices().then(setDevices);
    api.getBackendUrl().then(setBackendUrl);
    setAppVersion(api.getAppVersion());

    // Load saved preferences
    const savedMic = localStorage.getItem("settings:micName") ?? "";
    const savedLoopback = localStorage.getItem("settings:loopbackName") ?? "";
    setMicName(savedMic);
    setLoopbackName(savedLoopback);
  }, [api]);

  const handleSave = () => {
    localStorage.setItem("settings:micName", micName);
    localStorage.setItem("settings:loopbackName", loopbackName);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSignOut = async () => {
    if (!api) return;
    await api.signOut();
    window.location.reload();
  };

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      {/* Audio Devices — Electron only */}
      {api && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Audio Devices</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Microphone
              </label>
              <select
                value={micName}
                onChange={(e) => setMicName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.name}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                System Audio (Loopback)
              </label>
              <select
                value={loopbackName}
                onChange={(e) => setLoopbackName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.name}>{d.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
            >
              {saved ? "Saved!" : "Save"}
            </button>
          </div>
        </section>
      )}

      {/* App Info */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">About</h2>
        <dl className="space-y-2 text-sm">
          {appVersion && (
            <div className="flex justify-between">
              <dt className="text-gray-500">App Version</dt>
              <dd className="text-gray-900">{appVersion}</dd>
            </div>
          )}
          {backendUrl && (
            <div className="flex justify-between">
              <dt className="text-gray-500">Backend URL</dt>
              <dd className="text-gray-900 font-mono text-xs">{backendUrl}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* Sign Out */}
      <section>
        <button
          onClick={handleSignOut}
          className="px-4 py-2 border border-red-300 text-red-600 text-sm font-medium rounded-md hover:bg-red-50 transition-colors"
        >
          Sign Out
        </button>
      </section>
    </div>
  );
}
