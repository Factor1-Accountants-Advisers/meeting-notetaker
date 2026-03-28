"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  CheckSquare,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useMeeting } from "@/lib/api";
import AudioPlayer, { type AudioPlayerHandle } from "@/components/AudioPlayer";
import ActionItemsTable from "@/components/ActionItemsTable";
import ExportMenu from "@/components/ExportMenu";
import StatusBadge from "@/components/StatusBadge";
import ProcessingProgress from "@/components/ProcessingProgress";

const SPEAKER_COLORS = [
  "text-blue-400",
  "text-purple-400",
  "text-emerald-400",
  "text-amber-400",
  "text-rose-400",
  "text-cyan-400",
];

const INITIAL_SEGMENTS = 5;

function formatTimestamp(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-4 bg-gray-800 rounded animate-pulse"
          style={{ width: `${70 + Math.random() * 30}%` }}
        />
      ))}
    </div>
  );
}

interface MeetingDetailContentProps {
  meetingId?: number;
  onClose?: () => void;
}

export default function MeetingDetailContent({
  meetingId: meetingIdProp,
  onClose,
}: MeetingDetailContentProps) {
  const params = useParams<{ id: string[] | string }>();
  const router = useRouter();
  const rawId = params?.id;
  const paramId = Array.isArray(rawId) ? rawId[0] : rawId;
  const numericId = meetingIdProp ?? (paramId ? Number(paramId) : undefined);

  const [pollInterval, setPollInterval] = useState(3000);
  const { data: m, error, isLoading } = useMeeting(numericId, {
    refreshInterval: pollInterval,
  });

  // Stop polling when terminal
  useEffect(() => {
    if (m?.status === "complete" || m?.status === "failed") {
      setPollInterval(0);
    }
  }, [m?.status]);

  const audioRef = useRef<AudioPlayerHandle>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);

  if (!numericId) return <div className="text-gray-500">No meeting selected.</div>;
  if (isLoading) return <div className="text-gray-500">Loading meeting...</div>;
  if (error || !m) return <div className="text-red-400">Meeting not found.</div>;

  const segments = m.transcript?.segments ?? [];
  const visibleSegments = transcriptExpanded
    ? segments
    : segments.slice(0, INITIAL_SEGMENTS);

  const speakerColors: Record<string, string> = {};
  const uniqueSpeakers = Array.from(new Set(segments.map((s) => s.speaker)));
  uniqueSpeakers.forEach((speaker, i) => {
    speakerColors[speaker] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
  });

  const isProcessing = m.status !== "complete" && m.status !== "failed";

  return (
    <div className="max-w-3xl">
      {/* Back link */}
      <button
        onClick={() => (onClose ? onClose() : router.push("/"))}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        {onClose ? "Close" : "Back to Meetings"}
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-bold text-gray-100">{m.title}</h1>
            <StatusBadge status={m.status} />
          </div>
          <p className="text-sm text-gray-500">
            {m.scheduled_time &&
              new Date(m.scheduled_time).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            {m.duration_seconds &&
              ` · ${Math.round(m.duration_seconds / 60)} min`}
            {m.participants.length > 0 &&
              ` · ${m.participants.map((p) => p.name).join(", ")}`}
          </p>
        </div>
        {m.status === "complete" && (
          <ExportMenu
            meetingTitle={m.title}
            segments={m.transcript?.segments ?? null}
            summary={m.summary}
          />
        )}
      </div>

      {/* Audio player */}
      {m.audio_url ? (
        <AudioPlayer ref={audioRef} src={m.audio_url} />
      ) : (
        <div className="py-3 px-4 rounded-lg bg-gray-800/50 text-sm text-gray-600 mb-6">
          Audio unavailable
        </div>
      )}

      {/* Processing progress */}
      {isProcessing && (
        <div className="mt-6">
          <ProcessingProgress meetingId={m.id} status={m.status} />
        </div>
      )}

      {/* Summary */}
      <div className="mt-8 p-5 rounded-xl bg-gray-900/50 border border-gray-800">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="w-4 h-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-300">Summary</h2>
        </div>
        {m.summary ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">
              {m.summary.summary_text}
            </p>
            {m.summary.key_points.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                  Key Points
                </h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-400">
                  {m.summary.key_points.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {m.summary.follow_ups.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                  Follow-ups
                </h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-400">
                  {m.summary.follow_ups.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <SkeletonBlock lines={4} />
        )}
      </div>

      {/* Action Items */}
      <div className="mt-6 p-5 rounded-xl bg-gray-900/50 border border-gray-800">
        <div className="flex items-center gap-2 mb-4">
          <CheckSquare className="w-4 h-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-300">Action Items</h2>
          {m.action_items.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-gray-800 text-xs text-gray-400">
              {m.action_items.length}
            </span>
          )}
        </div>
        {m.action_items.length > 0 || m.status === "complete" ? (
          <ActionItemsTable items={m.action_items} />
        ) : (
          <SkeletonBlock lines={3} />
        )}
      </div>

      {/* Transcript */}
      <div className="mt-6 p-5 rounded-xl bg-gray-900/50 border border-gray-800">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">Transcript</h2>
        {segments.length > 0 ? (
          <div className="space-y-3">
            {visibleSegments.map((seg, i) => (
              <div key={i} className="flex gap-3">
                <div className="flex-shrink-0 w-20">
                  <span className={`text-xs font-medium ${speakerColors[seg.speaker] || "text-gray-400"}`}>
                    {seg.speaker}
                  </span>
                  <button
                    onClick={() => audioRef.current?.seekTo(seg.start)}
                    className="block text-[10px] text-gray-600 hover:text-blue-400 mt-0.5 transition-colors"
                  >
                    {formatTimestamp(seg.start)}
                  </button>
                </div>
                <p className="text-sm text-gray-400 leading-relaxed flex-1">
                  {seg.text}
                </p>
              </div>
            ))}
            {segments.length > INITIAL_SEGMENTS && (
              <button
                onClick={() => setTranscriptExpanded(!transcriptExpanded)}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2 transition-colors"
              >
                {transcriptExpanded ? (
                  <>
                    <ChevronUp className="w-3 h-3" /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" /> Show full transcript (
                    {segments.length} segments)
                  </>
                )}
              </button>
            )}
          </div>
        ) : m.status === "complete" ? (
          <p className="text-sm text-gray-600 italic">No transcript available</p>
        ) : (
          <SkeletonBlock lines={5} />
        )}
      </div>
    </div>
  );
}
