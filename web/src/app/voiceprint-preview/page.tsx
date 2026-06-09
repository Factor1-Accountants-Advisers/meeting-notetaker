"use client";

import { useState } from "react";
import { ShieldCheck, Upload, Ban, Trash2 } from "lucide-react";

const BACKEND = typeof window !== "undefined"
  ? `${window.location.protocol}//${window.location.hostname}:8000`
  : "";

export default function VoiceprintPreviewPage() {
  const [voiceSample, setVoiceSample] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "active" | "none">("loading");
  const [voiceprintId, setVoiceprintId] = useState<number | null>(null);

  const handleUpload = async () => {
    if (!voiceSample) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Note: upload requires auth token in production; this preview
      // verifies the UI renders and handles states correctly.
      const formData = new FormData();
      formData.append("sample_file", voiceSample);
      formData.append("consent_confirmed", "true");
      if (voiceSample.duration) {
        formData.append("sample_duration_seconds", String(voiceSample.duration));
      }

      const res = await fetch(`${BACKEND}/api/voiceprints`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data: Record<string, unknown> = await res.json().catch(() => ({}));
        throw new Error((data.detail as string) || `Upload failed (${res.status})`);
      }

      const result = await res.json();
      setVoiceprintId(result.id);
      setStatus("active");
      setNotice("Voice ID sample uploaded. Future meetings can use it for speaker identification.");
      setVoiceSample(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Voice ID upload failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!voiceprintId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${BACKEND}/api/voiceprints/${voiceprintId}/disable`, { method: "POST" });
      if (!res.ok) throw new Error(`Disable failed (${res.status})`);
      setStatus("none");
      setVoiceprintId(null);
      setNotice("Voice ID disabled. It will not be used for future meetings.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable Voice ID");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!voiceprintId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${BACKEND}/api/voiceprints/${voiceprintId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setStatus("none");
      setVoiceprintId(null);
      setNotice("Voice ID deleted from future speaker matching.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete Voice ID");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-2xl px-6">
      <p className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        Preview only — auth is not enforced. Upload requires a valid token in production.
      </p>

      <section className="rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-6 py-6">
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
          {status === "loading" ? (
            <p className="text-[color:var(--text-secondary)]">Loading Voice ID status...</p>
          ) : status === "active" ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-[color:var(--text-primary)]">Voice ID active</p>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                  1 active sample. Ready for speaker identification.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleDisable}
                  disabled={busy}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-[color:var(--border-subtle)] px-4 text-xs font-medium text-[color:var(--text-secondary)] transition hover:bg-[color:var(--surface-elevated)] disabled:opacity-50"
                >
                  <Ban className="h-3.5 w-3.5" />
                  Disable
                </button>
                <button
                  onClick={handleDelete}
                  disabled={busy}
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
          {error && (
            <p className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-300">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
              {notice}
            </p>
          )}
          <button
            onClick={handleUpload}
            disabled={!voiceSample || busy}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[color:var(--surface-inverse)] px-5 text-sm font-medium text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {busy ? "Processing..." : "Create Voice ID"}
          </button>
        </div>
      </section>
    </div>
  );
}
