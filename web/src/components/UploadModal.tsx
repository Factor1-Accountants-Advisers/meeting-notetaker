"use client";

import { useState, useRef } from "react";
import { uploadMeeting } from "@/lib/api";
import { useSWRConfig } from "swr";

interface Attendee {
  name: string;
  email: string;
}

const ACCEPTED_TYPES = ".wav,.mp3,.mp4,.m4v,.mov";

export default function UploadModal({ onClose }: { onClose: () => void }) {
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
      await uploadMeeting({
        file,
        title: title.trim(),
        attendees,
        scheduledTime: scheduledTime || undefined,
      });
      // Revalidate meetings list
      await mutate((key: unknown) => typeof key === "string" && key.startsWith("/api/meetings"));
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const isVideo = file && /\.(mp4|m4v|mov)$/i.test(file.name);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Upload Meeting Recording</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* File picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
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
              className="w-full border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-400 transition-colors"
            >
              {file ? (
                <div>
                  <p className="text-sm font-medium text-gray-900">{file.name}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                    {isVideo && " — audio will be extracted automatically"}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-gray-500">Click to select a file</p>
                  <p className="text-xs text-gray-400 mt-1">WAV, MP3, or MP4 (video)</p>
                </div>
              )}
            </button>
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Meeting Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sprint Planning - Week 12"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Attendees */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Attendees <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={attendeeInput}
                onChange={(e) => setAttendeeInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addAttendee())}
                placeholder="Name <email> or email"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={addAttendee}
                className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200 transition-colors"
              >
                Add
              </button>
            </div>
            {attendees.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {attendees.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs"
                  >
                    {a.name}{a.email ? ` <${a.email}>` : ""}
                    <button
                      onClick={() => removeAttendee(i)}
                      className="hover:text-blue-900 ml-0.5"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
          <button
            onClick={onClose}
            disabled={uploading}
            className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!file || !title.trim() || attendees.length === 0 || uploading}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
