"use client";

import { useState, useRef } from "react";
import { useParams } from "next/navigation";
import { useMeeting } from "@/lib/api";
import MeetingHeader from "@/components/MeetingHeader";
import AudioPlayer, { type AudioPlayerHandle } from "@/components/AudioPlayer";
import TranscriptView from "@/components/TranscriptView";
import SummaryView from "@/components/SummaryView";
import ActionItemsTable from "@/components/ActionItemsTable";
import ExportMenu from "@/components/ExportMenu";

type Tab = "transcript" | "summary" | "actions";

const tabs: { key: Tab; label: string }[] = [
  { key: "transcript", label: "Transcript" },
  { key: "summary", label: "Summary" },
  { key: "actions", label: "Action Items" },
];

export default function MeetingDetailContent() {
  const params = useParams<{ id: string[] | string }>();
  const rawId = params?.id;
  const meetingId = Array.isArray(rawId) ? rawId[0] : rawId;

  const { data: meeting, error, isLoading } = useMeeting(meetingId ? Number(meetingId) : undefined);
  const [activeTab, setActiveTab] = useState<Tab>("transcript");
  const audioRef = useRef<AudioPlayerHandle>(null);

  if (!meetingId) return <div className="text-gray-500">No meeting selected.</div>;
  if (isLoading) return <div className="text-gray-500">Loading meeting...</div>;
  if (error || !meeting) return <div className="text-red-600">Meeting not found.</div>;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <MeetingHeader meeting={meeting} />
        <ExportMenu
          meetingTitle={meeting.title}
          segments={meeting.transcript?.segments ?? null}
          summary={meeting.summary}
        />
      </div>
      <AudioPlayer ref={audioRef} src={meeting.audio_url} />

      {/* Tabs */}
      <div className="mt-6 border-b border-gray-200">
        <nav className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
              {tab.key === "actions" && meeting.action_items.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">
                  {meeting.action_items.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {activeTab === "transcript" && (
          <TranscriptView
            segments={meeting.transcript?.segments ?? []}
            onSeek={(s) => audioRef.current?.seekTo(s)}
          />
        )}
        {activeTab === "summary" && <SummaryView summary={meeting.summary} />}
        {activeTab === "actions" && (
          <ActionItemsTable items={meeting.action_items} />
        )}
      </div>
    </div>
  );
}
