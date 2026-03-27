"use client";

import { useState } from "react";
import { getElectronAPIOrNull } from "@/lib/electron-bridge";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";
import CalendarPanel from "@/components/CalendarPanel";
import RecordingControls from "@/components/RecordingControls";
import type { CalendarEvent } from "@/types";

export default function DashboardPage() {
  const [showUpload, setShowUpload] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<CalendarEvent | null>(null);
  const electron = !!getElectronAPIOrNull();

  return (
    <div className={electron ? "flex gap-8" : ""}>
      {/* Sidebar — Electron only */}
      {electron && (
        <aside className="w-64 flex-shrink-0 space-y-6">
          <CalendarPanel
            onSelectMeeting={setSelectedMeeting}
            selectedMeetingId={selectedMeeting?.id ?? null}
          />
          <hr className="border-gray-200" />
          <RecordingControls selectedMeeting={selectedMeeting} />
        </aside>
      )}

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Meetings</h1>
          <button
            onClick={() => setShowUpload(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
          >
            Upload Recording
          </button>
        </div>
        <MeetingList />
        {showUpload && <UploadModal onClose={() => setShowUpload(false)} />}
      </div>
    </div>
  );
}
