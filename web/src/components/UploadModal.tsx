"use client";

import { useState, useRef } from "react";
import { Upload, X } from "lucide-react";
import { uploadMeeting } from "@/lib/api";
import { useSWRConfig } from "swr";

interface Attendee {
  name: string;
  email: string;
}

const ACCEPTED_TYPES = ".wav,.mp3,.mp4,.m4v,.mov";

export default function UploadModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded?: (meetingId: number) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [attendeeInput, setAttendeeInput] = useState("");
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledTime, setScheduledTime] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { mutate } = useSWRConfig();

  const addAttendee = () => {
    const trimmed = attendeeInput.trim();
    if (!trimmed) return;

    // Accept "Name <email>" or just "email"
    const match = trimmed.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      setAttendees((prev) => [...prev, { name: match[1].trim(), email: match[2].trim() }]);
    } else if (trimmed.includes("@")) {
      const name = trimmed.split("@")[0];
      setAttendees((prev) => [...prev, { name, email: trimmed }]);
    } else {
      setAttendees((prev) => [...prev, { name: trimmed, email: "" }]);
    }
    setAttendeeInput("");
  };

  const removeAttendee = (idx: number) => {
    setAttendees((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!file) return;
    if (!title.trim()) {
      setError("Meeting title is required");
      return;
    }
    if (attendees.length === 0) {
      setError("At least one attendee is required for speaker identification");
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const result = await uploadMeeting({
        file,
        title: title.trim(),
        attendees,
        scheduledTime: scheduledTime || undefined,
      });
      // Revalidate meetings list
      await mutate((key: unknown) => typeof key === "string" && key.startsWith("/api/meetings"));
      onUploaded?.(result.meeting_id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const isVideo = file && /\.(mp4|m4v|mov)$/i.test(file.name);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[32px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-panel)]">
        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-subtle)] px-7 py-6">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
              Upload meeting recording
            </h2>
            <p className="mt-2 text-sm leading-6 text-[color:var(--text-secondary)]">
              Add a file, give the meeting a clear title, and include attendees so speaker identification is more accurate.
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-1 inline-flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] text-[color:var(--text-muted)] transition hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-7 py-6">
          <div>
            <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
              Audio / Video File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setFile(f);
                if (f && !scheduledTime) {
                  setScheduledTime(new Date(f.lastModified).toISOString().slice(0, 16));
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center rounded-[28px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--surface-soft)] px-6 py-10 text-center transition hover:border-[color:var(--accent)] hover:bg-[color:var(--surface)]"
            >
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] text-[color:var(--accent-text)]">
                <Upload className="h-5 w-5" />
              </div>
              {file ? (
                <div>
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">{file.name}</p>
                  <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                    {isVideo && " — audio will be extracted automatically"}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">
                    Click to select a file
                  </p>
                  <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                    WAV, MP3, MP4, M4V, or MOV
                  </p>
                </div>
              )}
            </button>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
              Meeting Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sprint Planning - Week 12"
              className="h-12 w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[color:var(--text-primary)]">
              Attendees <span className="text-[color:var(--danger)]">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={attendeeInput}
                onChange={(e) => setAttendeeInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addAttendee())}
                placeholder="Name <email> or email"
                className="h-12 flex-1 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
              />
              <button
                type="button"
                onClick={addAttendee}
                className="inline-flex h-12 items-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-5 text-sm font-medium text-[color:var(--text-primary)] transition hover:border-[color:var(--border-strong)] hover:bg-white"
              >
                Add
              </button>
            </div>
            <p className="mt-2 text-xs leading-6 text-[color:var(--text-secondary)]">
              Add at least one attendee. This improves speaker matching and transcript quality.
            </p>
            {attendees.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {attendees.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 py-1.5 text-xs text-[color:var(--text-primary)]"
                  >
                    {a.name}{a.email ? ` <${a.email}>` : ""}
                    <button
                      onClick={() => removeAttendee(i)}
                      className="ml-0.5 text-[color:var(--text-muted)] transition hover:text-[color:var(--text-primary)]"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-2xl border border-[color:var(--danger-soft)] bg-[color:var(--danger-soft)] px-4 py-3 text-sm text-[color:var(--danger)]">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[color:var(--border-subtle)] px-7 py-5">
          <button
            onClick={onClose}
            disabled={uploading}
            className="inline-flex h-12 items-center rounded-full px-5 text-sm font-medium text-[color:var(--text-secondary)] transition hover:text-[color:var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!file || !title.trim() || attendees.length === 0 || uploading}
            className="inline-flex h-12 items-center rounded-full bg-[color:var(--surface-inverse)] px-6 text-sm font-medium text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
