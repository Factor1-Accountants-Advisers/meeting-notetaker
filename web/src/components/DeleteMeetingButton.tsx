"use client";

import { useState } from "react";
import { deleteMeeting } from "@/lib/api";
import { useSWRConfig } from "swr";

interface DeleteMeetingButtonProps {
  meetingId: number;
  meetingTitle: string;
}

export default function DeleteMeetingButton({ meetingId, meetingTitle }: DeleteMeetingButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { mutate } = useSWRConfig();

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteMeeting(meetingId);
      await mutate((key: unknown) => typeof key === "string" && key.startsWith("/api/meetings"));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex gap-1 text-xs">
        <span className="text-gray-500">Delete?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-600 hover:text-red-800 font-medium"
        >
          {deleting ? "..." : "Yes"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-gray-500 hover:text-gray-700"
        >
          No
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-gray-400 hover:text-red-600 transition-colors text-sm"
      title={`Delete ${meetingTitle}`}
    >
      Delete
    </button>
  );
}
