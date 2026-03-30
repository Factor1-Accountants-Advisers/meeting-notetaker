"use client";

import { useState } from "react";
import Link from "next/link";
import { useMeetings } from "@/lib/api";
import StatusBadge from "./StatusBadge";
import SearchFilter from "./SearchFilter";
import DeleteMeetingButton from "./DeleteMeetingButton";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  return `${m} min`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface MeetingListProps {
  onSelectMeeting?: (id: number) => void;
  selectedMeetingId?: number | null;
}

export default function MeetingList({
  onSelectMeeting,
  selectedMeetingId,
}: MeetingListProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const { data, error, isLoading } = useMeetings(
    1,
    20,
    statusFilter || undefined
  );

  const hasFilters = search !== "" || statusFilter !== "";

  const filtered = (data?.items ?? []).filter((m) => {
    if (search && !m.title.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
          Past Meetings
        </p>
        <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
          Your recent transcripts, summaries, and extracted action items.
        </p>
      </div>

      <SearchFilter
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
      />

      {isLoading && (
        <div className="py-4 text-sm text-[color:var(--text-muted)]">Loading meetings...</div>
      )}
      {error && (
        <div className="py-4 text-sm text-[color:var(--danger)]">
          {error.message || "Failed to load meetings."}
        </div>
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="rounded-[24px] border border-dashed border-[color:var(--border-strong)] px-4 py-5 text-sm text-[color:var(--text-muted)]">
          {hasFilters
            ? "No meetings match your filters."
            : "No meetings yet."}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2 mt-3">
          {filtered.map((m) => {
            const isSelected = selectedMeetingId === m.id;
            const CardWrapper = onSelectMeeting ? "button" : "div";

            return (
              <CardWrapper
                key={m.id}
                onClick={
                  onSelectMeeting
                    ? () => onSelectMeeting(m.id)
                    : undefined
                }
                className={`relative w-full rounded-[22px] border p-4 text-left transition-all ${
                  isSelected
                    ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                    : "border-[color:var(--border-subtle)] bg-[color:var(--surface)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-elevated)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {onSelectMeeting ? (
                      <span className="block truncate text-sm font-medium text-[color:var(--text-primary)]">
                        {m.title}
                      </span>
                    ) : (
                      <Link
                        href={`/meetings/${m.id}`}
                        className="block truncate text-sm font-medium text-[color:var(--text-primary)] hover:text-[color:var(--accent-text)]"
                      >
                        {m.title}
                      </Link>
                    )}
                    <div className="mt-2 flex items-center gap-2 text-xs text-[color:var(--text-secondary)]">
                      {formatDate(m.scheduled_time) && (
                        <span>{formatDate(m.scheduled_time)}</span>
                      )}
                      {formatDuration(m.duration_seconds) && (
                        <>
                          <span>·</span>
                          <span>{formatDuration(m.duration_seconds)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <StatusBadge status={m.status} />
                    <DeleteMeetingButton
                      meetingId={m.id}
                      meetingTitle={m.title}
                    />
                  </div>
                </div>
              </CardWrapper>
            );
          })}
        </div>
      )}
    </div>
  );
}
