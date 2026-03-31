"use client";

import { useId } from "react";

import { formatDueDate } from "./dateFormatting";

type ActionItemContextPanelProps = {
  meetingTitle: string;
  meetingSummary: string;
  actionItem: {
    id: number;
    description: string;
    owner_name: string | null;
    due_date: string | null;
    status: string;
  } | null;
};

function formatStatus(value: string): string {
  if (!value) return "Unknown";

  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatOwnerName(value: string | null): string {
  if (!value || !value.trim()) return "Unassigned";

  return value;
}

export default function ActionItemContextPanel({
  meetingTitle,
  meetingSummary,
  actionItem,
}: ActionItemContextPanelProps) {
  const instanceId = useId();
  const meetingTitleId = `${instanceId}-meeting-title`;
  const actionItemTitleId = `${instanceId}-action-item-title`;

  return (
    <aside
      aria-label="Action item context"
      className="h-full border-t border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)]/65 p-6 xl:border-l xl:border-t-0"
    >
      <div className="space-y-6 xl:sticky xl:top-8">
        <section
          aria-labelledby={meetingTitleId}
          className="rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-5 shadow-[var(--shadow-soft)]"
        >
          <h2
            id={meetingTitleId}
            className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]"
          >
            Source meeting
          </h2>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
            {meetingTitle}
          </h3>
          <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
            {meetingSummary}
          </p>
        </section>

        <section
          aria-labelledby={actionItemTitleId}
          className="rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-5 shadow-[var(--shadow-soft)]"
        >
          <h2
            id={actionItemTitleId}
            className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]"
          >
            Selected action item
          </h2>

          {actionItem ? (
            <>
              <h3 className="mt-3 text-xl font-semibold tracking-tight text-[color:var(--text-primary)]">
                {actionItem.description}
              </h3>

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-[color:var(--text-secondary)]">Owner</dt>
                  <dd className="font-medium text-[color:var(--text-primary)]">
                    {formatOwnerName(actionItem.owner_name)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-[color:var(--text-secondary)]">
                    Due date
                  </dt>
                  <dd className="font-medium text-[color:var(--text-primary)]">
                    {formatDueDate(actionItem.due_date)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-[color:var(--text-secondary)]">Status</dt>
                  <dd className="font-medium text-[color:var(--text-primary)]">
                    {formatStatus(actionItem.status)}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
              No action item selected.
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
