"use client";

import type { ActionItem } from "@/types";

function formatDueDate(value: string | null): string {
  if (!value) return "No due date";

  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function MeetingActionItemsView({
  meetingTitle,
  items,
  selectedActionItemId,
  onSelectActionItem,
}: {
  meetingTitle: string;
  items: ActionItem[];
  selectedActionItemId: number | null;
  onSelectActionItem: (id: number) => void;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col rounded-[32px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-panel)]">
      <div className="border-b border-[color:var(--border-subtle)] px-6 py-5">
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
          {meetingTitle}
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {items.length === 0 ? (
          <div className="rounded-[24px] border border-dashed border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-4 py-6 text-sm text-[color:var(--text-muted)]">
            No action items in this meeting.
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const selected = item.id === selectedActionItemId;

              return (
                <button
                  key={item.id}
                  type="button"
                  data-selected={selected ? "true" : undefined}
                  onClick={() => onSelectActionItem(item.id)}
                  className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                    selected
                      ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]/50 shadow-[var(--shadow-soft)]"
                      : "border-transparent bg-transparent hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--surface-soft)]/70"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <p className="min-w-0 text-sm font-medium leading-6 text-[color:var(--text-primary)]">
                      {item.description}
                    </p>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-3 text-sm text-[color:var(--text-secondary)]">
                    <span>
                      Owner:{" "}
                      <span className="text-[color:var(--text-primary)]">
                        {item.owner_name ?? "Unassigned"}
                      </span>
                    </span>
                    <span>
                      Due:{" "}
                      <span className="text-[color:var(--text-primary)]">
                        {formatDueDate(item.due_date)}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
