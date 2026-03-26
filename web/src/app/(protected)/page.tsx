"use client";

import { useState } from "react";
import MeetingList from "@/components/MeetingList";
import UploadModal from "@/components/UploadModal";

export default function DashboardPage() {
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div>
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
  );
}
