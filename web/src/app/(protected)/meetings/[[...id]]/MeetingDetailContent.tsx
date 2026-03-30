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
          className="h-4 animate-pulse rounded-full bg-[color:var(--surface-soft)]"
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

  if (!numericId) return <div className="text-[color:var(--text-secondary)]">No meeting selected.</div>;
  if (isLoading) return <div className="text-[color:var(--text-secondary)]">Loading meeting...</div>;
  if (error || !m) return <div className="text-[color:var(--danger)]">Meeting not found.</div>;

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
    <div className="max-w-3xl pb-8">
      {/* Back link */}
      <button
        onClick={() => (onClose ? onClose() : router.push("/"))}
        className="mb-6 flex items-center gap-1 text-sm text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
      >
        <ArrowLeft className="w-4 h-4" />
        {onClose ? "Close" : "Back to Meetings"}
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-[2rem] font-semibold tracking-tight text-[color:var(--text-primary)]">{m.title}</h1>
            <StatusBadge status={m.status} />
          </div>
          <p className="text-sm text-[color:var(--text-secondary)]">
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
        <div className="mb-6 rounded-[20px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 py-3 text-sm text-[color:var(--text-secondary)]">
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
      <div className="surface-card mt-8 rounded-[28px] p-6 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="h-4 w-4 text-[color:var(--text-muted)]" />
          <h2 className="text-[1.05rem] font-semibold text-[color:var(--text-primary)]">Summary</h2>
        </div>
        {m.summary ? (
          <div className="space-y-4">
            <p className="text-[15px] leading-8 text-[color:var(--text-primary)]">
              {m.summary.summary_text}
            </p>
            {m.summary.key_points.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                  Key Points
                </h3>
                <ul className="list-disc list-inside space-y-2 text-sm leading-7 text-[color:var(--text-secondary)]">
                  {m.summary.key_points.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {m.summary.follow_ups.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                  Follow-ups
                </h3>
                <ul className="list-disc list-inside space-y-2 text-sm leading-7 text-[color:var(--text-secondary)]">
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
      <div className="surface-card mt-6 rounded-[28px] p-6 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2 mb-4">
          <CheckSquare className="h-4 w-4 text-[color:var(--text-muted)]" />
          <h2 className="text-[1.05rem] font-semibold text-[color:var(--text-primary)]">Action Items</h2>
          {m.action_items.length > 0 && (
            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-[color:var(--surface-soft)] px-2 text-xs font-medium text-[color:var(--text-secondary)]">
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
      <div className="surface-card mt-6 rounded-[28px] p-6 shadow-[var(--shadow-soft)]">
        <h2 className="mb-4 text-[1.05rem] font-semibold text-[color:var(--text-primary)]">Transcript</h2>
        {segments.length > 0 ? (
          <div className="space-y-5">
            {visibleSegments.map((seg, i) => (
              <div key={i} className="flex gap-4 rounded-[22px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)] px-4 py-4">
                <div className="w-24 flex-shrink-0">
                  <span className={`text-sm font-semibold ${speakerColors[seg.speaker] || "text-[color:var(--text-secondary)]"}`}>
                    {seg.speaker}
                  </span>
                  <button
                    onClick={() => audioRef.current?.seekTo(seg.start)}
                    className="mt-1 block text-xs text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--accent-text)]"
                  >
                    {formatTimestamp(seg.start)}
                  </button>
                </div>
                <p className="flex-1 text-[15px] leading-8 text-[color:var(--text-secondary)]">
                  {seg.text}
                </p>
              </div>
            ))}
            {segments.length > INITIAL_SEGMENTS && (
              <button
                onClick={() => setTranscriptExpanded(!transcriptExpanded)}
                className="mt-2 flex items-center gap-1 text-xs font-medium text-[color:var(--accent-text)] transition-colors hover:opacity-80"
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
          <p className="text-sm italic text-[color:var(--text-secondary)]">No transcript available</p>
        ) : (
          <SkeletonBlock lines={5} />
        )}
      </div>
    </div>
  );
}
