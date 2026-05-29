"use client";

import { useEffect, useId, useState } from "react";

import type { ActionOwnerSource } from "@/types";

type ActionItemFields = {
  id: number;
  description: string;
  owner_name: string | null;
  owner_confidence?: number | null;
  owner_source?: ActionOwnerSource | null;
  owner_reason?: string | null;
  due_date: string | null;
  status: string;
};

type ActionItemContextPanelProps = {
  meetingTitle: string;
  meetingSummary: string;
  actionItem: ActionItemFields | null;
  onSave?: (id: number, update: Partial<ActionItemFields>) => Promise<void>;
  onDelete?: (id: number) => Promise<void>;
};

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "complete", label: "Complete" },
];

function getOwnerConfidenceLabel(actionItem: ActionItemFields, ownerName: string) {
  if ((actionItem.owner_name ?? "").trim() !== ownerName.trim()) {
    return "Owner changed";
  }

  if (!ownerName.trim()) {
    return "Owner uncertain";
  }

  if (actionItem.owner_source === "user_corrected") {
    return "Owner confirmed";
  }

  const confidence = actionItem.owner_confidence ?? 0;
  if (confidence >= 0.8) {
    return "Owner likely";
  }

  if (confidence >= 0.7) {
    return "Owner tentative";
  }

  return "Owner uncertain";
}

export default function ActionItemContextPanel({
  meetingTitle,
  meetingSummary,
  actionItem,
  onSave,
  onDelete,
}: ActionItemContextPanelProps) {
  const instanceId = useId();
  const taskSectionId = `${instanceId}-task`;
  const meetingSectionId = `${instanceId}-meeting`;
  const descriptionInputId = `${instanceId}-description`;
  const ownerInputId = `${instanceId}-owner`;
  const dueDateInputId = `${instanceId}-due-date`;
  const statusInputId = `${instanceId}-status`;

  const [description, setDescription] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState("open");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (actionItem) {
      setDescription(actionItem.description);
      setOwnerName(actionItem.owner_name ?? "");
      setDueDate(actionItem.due_date ?? "");
      setStatus(actionItem.status);
      setDirty(false);
    }
  }, [actionItem]);

  function markDirty() {
    setDirty(true);
  }

  function handleReset() {
    if (!actionItem) return;
    setDescription(actionItem.description);
    setOwnerName(actionItem.owner_name ?? "");
    setDueDate(actionItem.due_date ?? "");
    setStatus(actionItem.status);
    setDirty(false);
  }

  async function handleSave() {
    if (!actionItem || !onSave) return;
    setSaving(true);
    try {
      await onSave(actionItem.id, {
        description,
        owner_name: ownerName || null,
        due_date: dueDate || null,
        status,
      });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!actionItem || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(actionItem.id);
    } finally {
      setDeleting(false);
    }
  }

  const inputBase =
    "w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-4 py-3 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] transition-[border-color,box-shadow] duration-150 focus:border-[color:var(--accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]";

  const ownerConfidenceLabel = actionItem
    ? getOwnerConfidenceLabel(actionItem, ownerName)
    : null;

  return (
    <aside
      aria-label="Action item context"
      className="flex h-full min-h-0 flex-col border-l border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)]/55"
    >
      {/* Scrollable body — matches app pattern */}
      <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-5">
        <div className="space-y-5">
          {/* ── Task Details ── */}
          <section aria-labelledby={taskSectionId}>
            <h2
              id={taskSectionId}
              className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]"
            >
              Task details
            </h2>

            {actionItem ? (
              <div className="mt-4 rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-5 shadow-[var(--shadow-soft)]">
                <div className="space-y-4">
                  {/* Description */}
                  <div>
                    <label
                      htmlFor={descriptionInputId}
                      className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--text-muted)]"
                    >
                      Description
                    </label>
                    <textarea
                      id={descriptionInputId}
                      value={description}
                      onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                      rows={3}
                      className={`${inputBase} resize-none`}
                      placeholder="Describe the action item..."
                    />
                  </div>

                  {/* Owner + Due Date — side by side */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor={ownerInputId}
                        className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--text-muted)]"
                      >
                        Owner
                      </label>
                      <input
                        id={ownerInputId}
                        type="text"
                        value={ownerName}
                        onChange={(e) => { setOwnerName(e.target.value); markDirty(); }}
                        className={inputBase}
                        placeholder="Unassigned"
                      />
                      {ownerConfidenceLabel && (
                        <p className="mt-1.5 inline-flex rounded-full border border-[color:var(--border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)]">
                          {ownerConfidenceLabel}
                        </p>
                      )}
                    </div>
                    <div>
                      <label
                        htmlFor={dueDateInputId}
                        className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--text-muted)]"
                      >
                        Due date
                      </label>
                      <input
                        id={dueDateInputId}
                        type="date"
                        value={dueDate}
                        onChange={(e) => { setDueDate(e.target.value); markDirty(); }}
                        className={inputBase}
                      />
                    </div>
                  </div>

                  {/* Status */}
                  <div>
                    <label
                      htmlFor={statusInputId}
                      className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.18em] text-[color:var(--text-muted)]"
                    >
                      Status
                    </label>
                    <select
                      id={statusInputId}
                      value={status}
                      onChange={(e) => { setStatus(e.target.value); markDirty(); }}
                      className={inputBase}
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Inline actions — sits inside the card */}
                <div className="mt-5 flex items-center gap-2 border-t border-[color:var(--border-subtle)] pt-4">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!dirty || saving}
                    className="flex-1 rounded-full bg-[color:var(--surface-inverse)] px-5 py-2.5 text-sm font-medium text-[color:var(--text-inverse)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
                  >
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={!dirty}
                    className="rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-5 py-2.5 text-sm font-medium text-[color:var(--text-primary)] transition-[border-color,background-color] duration-150 hover:border-[color:var(--border-strong)] hover:bg-white disabled:opacity-40"
                  >
                    Reset
                  </button>
                </div>

                {onDelete && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="mt-3 w-full rounded-full px-4 py-2 text-sm text-[color:var(--danger)] transition-colors duration-150 hover:bg-[color:var(--danger-soft)] disabled:opacity-40"
                  >
                    {deleting ? "Deleting..." : "Delete action item"}
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
                Select an action item to view and edit its details.
              </p>
            )}
          </section>

          {/* ── Source Meeting ── */}
          <section
            aria-labelledby={meetingSectionId}
            className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-5 shadow-[var(--shadow-soft)]"
          >
            <h2
              id={meetingSectionId}
              className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]"
            >
              Source meeting
            </h2>
            <h3 className="mt-3 text-lg font-semibold tracking-tight text-[color:var(--text-primary)]">
              {meetingTitle}
            </h3>
            <p className="mt-3 text-sm leading-7 text-[color:var(--text-secondary)]">
              {meetingSummary}
            </p>
          </section>
        </div>
      </div>
    </aside>
  );
}
