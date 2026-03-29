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
        className="cursor-pointer hover:bg-gray-700/50 px-1 py-0.5 rounded -mx-1"
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
      className="border border-blue-500/50 rounded px-1 py-0.5 text-sm w-full bg-gray-800 text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
    return <p className="text-gray-500">No action items.</p>;
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
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-gray-900">
      <table className="min-w-full divide-y divide-gray-700">
        <thead className="bg-gray-800">
          <tr>
            <th className="w-10 px-4 py-3"></th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Description</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Owner</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Due Date</th>
            {showMeetingLink && (
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">Meeting</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {items.map((item) => (
            <tr key={item.id} className={item.status === "complete" ? "bg-gray-800/50 opacity-60" : ""}>
              <td className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={item.status === "complete"}
                  onChange={() => toggleStatus(item)}
                  className="h-4 w-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 cursor-pointer bg-gray-800"
                />
              </td>
              <td className={`px-4 py-3 text-sm ${item.status === "complete" ? "line-through text-gray-500" : "text-gray-200"}`}>
                {item.description}
              </td>
              <td className="px-4 py-3 text-sm text-gray-400">
                <EditableCell
                  value={item.owner_name ?? ""}
                  onSave={(v) => saveField(item, "owner_name", v)}
                />
              </td>
              <td className="px-4 py-3 text-sm text-gray-400">
                <EditableCell
                  value={item.due_date ?? ""}
                  onSave={(v) => saveField(item, "due_date", v)}
                  type="date"
                />
              </td>
              {showMeetingLink && (
                <td className="px-4 py-3 text-sm">
                  <Link href={`/meetings/${item.meeting_id}`} className="text-blue-400 hover:underline">
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
