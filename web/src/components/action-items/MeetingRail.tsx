"use client";

import type { MeetingActionItemsGroup } from "@/components/action-items/types";

function formatCounts(group: MeetingActionItemsGroup): string {
  return `${group.openCount} open · ${group.completedCount} completed`;
}

export default function MeetingRail({
  groups,
  selectedMeetingId,
  onSelectMeeting,
}: {
  groups: MeetingActionItemsGroup[];
  selectedMeetingId: number | null;
  onSelectMeeting: (meetingId: number) => void;
}) {
  return (
    <aside className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)]/55 p-5 xl:border-b-0 xl:border-r">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
            Meetings
          </p>
          <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
            Browse context by meeting.
          </p>
        </div>
        <span className="rounded-full bg-[color:var(--surface)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
          {groups.length}
        </span>
      </div>

      <div className="mt-5 space-y-2">
        {groups.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-4 py-5 text-sm text-[color:var(--text-muted)]">
            No meetings available.
          </div>
        ) : (
          groups.map((group) => {
            const selected = group.meetingId === selectedMeetingId;
            const counts = formatCounts(group);

            return (
              <button
                key={group.meetingId}
                type="button"
                onClick={() => onSelectMeeting(group.meetingId)}
                aria-pressed={selected}
                className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                  selected
                    ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                    : "border-transparent bg-transparent hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--surface)]"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">
                    {group.title}
                  </p>
                  <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
                    {counts}
                  </p>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
