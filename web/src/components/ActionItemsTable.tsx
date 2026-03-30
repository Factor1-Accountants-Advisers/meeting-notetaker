"use client";

import { useState } from "react";
import Link from "next/link";
import { useSWRConfig } from "swr";
import { updateActionItem } from "@/lib/api";
import type { ActionItem } from "@/types";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function EditableCell({
  value,
  onSave,
  type = "text",
}: {
  value: string;
  onSave: (v: string) => void;
  type?: "text" | "date";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <span
        onClick={() => { setDraft(value); setEditing(true); }}
        className="mx-[-4px] cursor-pointer rounded-lg px-1 py-0.5 transition hover:bg-[color:var(--surface-soft)]"
        title="Click to edit"
      >
        {type === "date" && value ? formatDate(value) : value || "—"}
      </span>
    );
  }

  return (
    <input
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { onSave(draft); setEditing(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { onSave(draft); setEditing(false); }
        if (e.key === "Escape") setEditing(false);
      }}
      autoFocus
      className="w-full rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] px-2 py-1 text-sm text-[color:var(--text-primary)] outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
    />
  );
}

interface ActionItemsTableProps {
  items: ActionItem[];
  showMeetingLink?: boolean;
}

export default function ActionItemsTable({
  items,
  showMeetingLink = false,
}: ActionItemsTableProps) {
  const { mutate } = useSWRConfig();

  if (items.length === 0) {
    return <p className="text-[color:var(--text-secondary)]">No action items.</p>;
  }

  async function saveField(item: ActionItem, field: string, value: string) {
    await updateActionItem(item.id, { [field]: value || null });
    mutate(
      (key: string) =>
        typeof key === "string" &&
        (key.includes("action-items") || key.includes(`/meetings/${item.meeting_id}`)),
      undefined,
      { revalidate: true }
    );
  }

  async function toggleStatus(item: ActionItem) {
    const newStatus = item.status === "open" ? "complete" : "open";
    await updateActionItem(item.id, { status: newStatus });
    mutate(
      (key: string) =>
        typeof key === "string" &&
        (key.includes("action-items") || key.includes(`/meetings/${item.meeting_id}`)),
      undefined,
      { revalidate: true }
    );
  }

  return (
    <div className="overflow-hidden rounded-[22px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)]">
      <table className="min-w-full divide-y divide-[color:var(--border-subtle)]">
        <thead className="bg-[color:var(--surface-soft)]">
          <tr>
            <th className="w-10 px-4 py-3"></th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">Description</th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">Owner</th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">Due Date</th>
            {showMeetingLink && (
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">Meeting</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--border-subtle)]">
          {items.map((item) => (
            <tr
              key={item.id}
              className={item.status === "complete" ? "bg-[color:var(--surface-soft)]/70 opacity-70" : ""}
            >
              <td className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={item.status === "complete"}
                  onChange={() => toggleStatus(item)}
                  className="h-4 w-4 cursor-pointer rounded border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] text-[color:var(--accent)] focus:ring-[color:var(--accent-soft)]"
                />
              </td>
              <td className={`px-4 py-3 text-sm leading-7 ${item.status === "complete" ? "line-through text-[color:var(--text-muted)]" : "text-[color:var(--text-primary)]"}`}>
                {item.description}
              </td>
              <td className="px-4 py-3 text-sm text-[color:var(--text-secondary)]">
                <EditableCell
                  value={item.owner_name ?? ""}
                  onSave={(v) => saveField(item, "owner_name", v)}
                />
              </td>
              <td className="px-4 py-3 text-sm text-[color:var(--text-secondary)]">
                <EditableCell
                  value={item.due_date ?? ""}
                  onSave={(v) => saveField(item, "due_date", v)}
                  type="date"
                />
              </td>
              {showMeetingLink && (
                <td className="px-4 py-3 text-sm">
                  <Link href={`/meetings/${item.meeting_id}`} className="text-[color:var(--accent-text)] hover:underline">
                    View
                  </Link>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
