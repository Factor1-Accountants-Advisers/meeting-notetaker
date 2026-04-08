"use client";

import { useState, useRef } from "react";
import { renameSpeaker } from "@/lib/api";

interface SpeakerLabelProps {
  name: string;
  colorClass: string;
  meetingId: number;
  onRenamed: (oldName: string, newName: string) => void;
}

export default function SpeakerLabel({
  name,
  colorClass,
  meetingId,
  onRenamed,
}: SpeakerLabelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [hasError, setHasError] = useState(false);
  const isSubmitting = useRef(false);

  function startEdit() {
    setIsEditing(true);
    setHasError(false);
  }

  async function save(input: HTMLInputElement) {
    const newName = input.value.trim();
    if (!newName || newName === name) {
      setIsEditing(false);
      return;
    }
    try {
      await renameSpeaker(meetingId, name, newName);
      onRenamed(name, newName);
      setIsEditing(false);
    } catch {
      setHasError(true);
      setTimeout(() => {
        setHasError(false);
        setIsEditing(false);
      }, 2000);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      isSubmitting.current = true;
      save(e.currentTarget).finally(() => {
        isSubmitting.current = false;
      });
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    if (isSubmitting.current) return;
    save(e.currentTarget);
  }

  if (!isEditing) {
    return (
      <span
        className={`cursor-pointer text-sm font-semibold ${colorClass} hover:opacity-70 transition-opacity`}
        onClick={startEdit}
        title="Click to rename"
      >
        {name}
      </span>
    );
  }

  return (
    <input
      type="text"
      defaultValue={name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={`w-24 rounded border px-1 text-sm font-semibold bg-[color:var(--surface-muted)] text-[color:var(--text-primary)] outline-none focus:ring-1 ${
        hasError
          ? "border-red-500 ring-red-500"
          : "border-[color:var(--accent-text)] ring-[color:var(--accent-text)]"
      }`}
    />
  );
}
