"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarRange,
  CheckCircle2,
  Circle,
  LayoutGrid,
  Rows3,
  Search,
  UserRound,
} from "lucide-react";
import { actionItemsLabMockData } from "./mock-data";
import {
  buildKanbanColumns,
  buildSummary,
  filterTasks,
} from "./selectors";
import type {
  ActionItemsLabColumn,
  ActionItemsLabDueFilter,
  ActionItemsLabFilters,
  ActionItemsLabMode,
  ActionItemsLabStatusFilter,
  ActionItemsLabSummary,
  ActionItemsLabTask,
} from "./types";

const TODAY = new Date("2026-03-31T09:00:00.000Z");

const DEFAULT_FILTERS: ActionItemsLabFilters = {
  search: "",
  owner: "",
  status: "all",
  due: "all",
};

const MODE_LABELS: Record<ActionItemsLabMode, string> = {
  workspace: "Workspace",
  kanban: "Kanban",
};

const STATUS_OPTIONS: { value: ActionItemsLabStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "complete", label: "Completed" },
];

const DUE_OPTIONS: { value: ActionItemsLabDueFilter; label: string }[] = [
  { value: "all", label: "Any due date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due this week" },
  { value: "no-due-date", label: "No due date" },
];

type MeetingGroup = {
  id: number;
  title: string;
  items: ActionItemsLabTask[];
  openCount: number;
  completedCount: number;
  owners: string[];
  summary: string;
  nextDue: string | null;
};

function formatDueDate(value: string | null): string {
  if (!value) return "No due date";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: ActionItemsLabMode;
  onChange: (mode: ActionItemsLabMode) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] p-1">
      {(["workspace", "kanban"] as const).map((value) => {
        const active = value === mode;
        const Icon = value === "workspace" ? Rows3 : LayoutGrid;

        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
              active
                ? "bg-[color:var(--surface-elevated)] text-[color:var(--text-primary)] shadow-[var(--shadow-soft)]"
                : "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
            }`}
          >
            <Icon className="h-4 w-4" />
            {MODE_LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}

function CompactSummary({
  summary,
}: {
  summary: ActionItemsLabSummary;
}) {
  const items = [
    { label: "Open", value: summary.open },
    { label: "Due this week", value: summary.dueThisWeek },
    { label: "Overdue", value: summary.overdue, tone: "text-[color:var(--danger)]" },
    { label: "Completed", value: summary.completed },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-4 py-2"
        >
          <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-muted)]">
            {item.label}
          </span>
          <span className={`ml-3 text-sm font-semibold text-[color:var(--text-primary)] ${item.tone ?? ""}`}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function FiltersBar({
  filters,
  onChange,
}: {
  filters: ActionItemsLabFilters;
  onChange: (filters: ActionItemsLabFilters) => void;
}) {
  const update = <K extends keyof ActionItemsLabFilters>(
    key: K,
    value: ActionItemsLabFilters[K]
  ) => onChange({ ...filters, [key]: value });

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_170px_170px]">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)]" />
        <input
          value={filters.search}
          onChange={(event) => update("search", event.target.value)}
          placeholder="Search tasks, meetings, or context"
          className="h-11 w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] pl-11 pr-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
        />
      </label>

      <label className="relative block">
        <UserRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)]" />
        <input
          value={filters.owner}
          onChange={(event) => update("owner", event.target.value)}
          placeholder="Owner"
          className="h-11 w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] pl-11 pr-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
        />
      </label>

      <select
        value={filters.status}
        onChange={(event) =>
          update("status", event.target.value as ActionItemsLabStatusFilter)
        }
        className="h-11 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] outline-none focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        value={filters.due}
        onChange={(event) =>
          update("due", event.target.value as ActionItemsLabDueFilter)
        }
        className="h-11 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] outline-none focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
      >
        {DUE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function buildMeetingGroups(tasks: ActionItemsLabTask[]): MeetingGroup[] {
  const groups = new Map<number, MeetingGroup>();

  for (const task of tasks) {
    const existing = groups.get(task.meetingId);

    if (existing) {
      existing.items.push(task);
      existing.openCount += task.status === "open" ? 1 : 0;
      existing.completedCount += task.status === "complete" ? 1 : 0;
      if (task.owner && !existing.owners.includes(task.owner)) {
        existing.owners.push(task.owner);
      }
      if (existing.summary.length < 160) {
        existing.summary = `${existing.summary} ${task.excerpt}`.trim();
      }
      if (
        task.dueDate &&
        (!existing.nextDue || task.dueDate < existing.nextDue) &&
        task.status === "open"
      ) {
        existing.nextDue = task.dueDate;
      }
      continue;
    }

    groups.set(task.meetingId, {
      id: task.meetingId,
      title: task.meetingTitle,
      items: [task],
      openCount: task.status === "open" ? 1 : 0,
      completedCount: task.status === "complete" ? 1 : 0,
      owners: task.owner ? [task.owner] : [],
      summary: task.excerpt,
      nextDue: task.status === "open" ? task.dueDate : null,
    });
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.nextDue && b.nextDue) return a.nextDue.localeCompare(b.nextDue);
    if (a.nextDue) return -1;
    if (b.nextDue) return 1;
    return a.title.localeCompare(b.title);
  });
}

function MeetingRail({
  meetings,
  selectedMeetingId,
  onSelectMeeting,
}: {
  meetings: MeetingGroup[];
  selectedMeetingId: number | null;
  onSelectMeeting: (id: number) => void;
}) {
  return (
    <aside className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)]/55 p-5 xl:border-b-0 xl:border-r">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
            Meetings
          </p>
          <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
            Split view anchored by source context.
          </p>
        </div>
        <span className="rounded-full bg-[color:var(--surface)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
          {meetings.length}
        </span>
      </div>

      <div className="mt-5 space-y-2">
        {meetings.map((meeting) => {
          const active = meeting.id === selectedMeetingId;

          return (
            <button
              key={meeting.id}
              type="button"
              onClick={() => onSelectMeeting(meeting.id)}
              className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                active
                  ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                  : "border-transparent bg-transparent hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--surface)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">
                    {meeting.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-[color:var(--text-secondary)]">
                    {meeting.summary}
                  </p>
                </div>
                <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
                  {meeting.openCount}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[color:var(--text-secondary)]">
                <span>{meeting.openCount} open</span>
                <span>{meeting.completedCount} done</span>
                <span>{meeting.nextDue ? `Next ${formatDueDate(meeting.nextDue)}` : "No due date"}</span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function MeetingTaskRow({
  task,
  selected,
  onSelect,
}: {
  task: ActionItemsLabTask;
  selected: boolean;
  onSelect: (task: ActionItemsLabTask) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className={`grid w-full gap-3 border-l-2 px-4 py-3 text-left transition md:grid-cols-[minmax(0,1fr)_130px_110px] ${
        selected
          ? "border-l-[color:var(--accent)] bg-[color:var(--accent-soft)]/50"
          : "border-l-transparent hover:bg-[color:var(--surface-soft)]/70"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-[color:var(--text-muted)]">
            {task.status === "complete" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <Circle className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">
              {task.title}
            </p>
            <p className="mt-1 line-clamp-1 text-sm text-[color:var(--text-secondary)]">
              {task.excerpt}
            </p>
          </div>
        </div>
      </div>
      <div className="text-sm text-[color:var(--text-secondary)]">
        {task.owner ?? "Unassigned"}
      </div>
      <div className="text-sm text-[color:var(--text-primary)]">
        {formatDueDate(task.dueDate)}
      </div>
    </button>
  );
}

function MeetingWorkspace({
  meeting,
  selectedTaskId,
  onSelectTask,
}: {
  meeting: MeetingGroup | null;
  selectedTaskId: string | null;
  onSelectTask: (task: ActionItemsLabTask) => void;
}) {
  if (!meeting) {
    return (
      <div className="px-5 py-8 text-sm text-[color:var(--text-muted)] md:px-6">
        No meeting matches the current filters.
      </div>
    );
  }

  const openTasks = meeting.items.filter((task) => task.status === "open");
  const completedTasks = meeting.items.filter((task) => task.status === "complete");

  return (
    <div className="space-y-8 p-5 md:p-6">
      <section className="border-b border-[color:var(--border-subtle)] pb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
          Meeting context
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
          {meeting.title}
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="rounded-full bg-[color:var(--surface-soft)] px-3 py-1 text-xs text-[color:var(--text-secondary)]">
            {meeting.openCount} open
          </span>
          <span className="rounded-full bg-[color:var(--surface-soft)] px-3 py-1 text-xs text-[color:var(--text-secondary)]">
            {meeting.completedCount} completed
          </span>
          <span className="rounded-full bg-[color:var(--surface-soft)] px-3 py-1 text-xs text-[color:var(--text-secondary)]">
            {meeting.owners.length > 0 ? meeting.owners.join(", ") : "Unassigned owners"}
          </span>
        </div>
        <p className="mt-5 max-w-3xl text-base leading-8 text-[color:var(--text-secondary)]">
          {meeting.summary}
        </p>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-3">
          <h3 className="text-base font-semibold tracking-tight text-[color:var(--text-primary)]">
            Open action items
          </h3>
          <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
            {openTasks.length}
          </span>
        </div>
        <div className="overflow-hidden rounded-[26px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)]">
          {openTasks.length === 0 ? (
            <div className="px-4 py-5 text-sm text-[color:var(--text-muted)]">
              No open action items in this meeting.
            </div>
          ) : (
            openTasks.map((task, index) => (
              <div
                key={task.id}
                className={index > 0 ? "border-t border-[color:var(--border-subtle)]" : ""}
              >
                <MeetingTaskRow
                  task={task}
                  selected={task.id === selectedTaskId}
                  onSelect={onSelectTask}
                />
              </div>
            ))
          )}
        </div>
      </section>

      {completedTasks.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-3">
            <h3 className="text-base font-semibold tracking-tight text-[color:var(--text-primary)]">
              Completed in this meeting
            </h3>
            <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
              {completedTasks.length}
            </span>
          </div>
          <div className="overflow-hidden rounded-[26px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)]">
            {completedTasks.map((task, index) => (
              <div
                key={task.id}
                className={index > 0 ? "border-t border-[color:var(--border-subtle)]" : ""}
              >
                <MeetingTaskRow
                  task={task}
                  selected={task.id === selectedTaskId}
                  onSelect={onSelectTask}
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function KanbanView({
  columns,
  selectedTaskId,
  onSelectTask,
}: {
  columns: ActionItemsLabColumn[];
  selectedTaskId: string | null;
  onSelectTask: (task: ActionItemsLabTask) => void;
}) {
  return (
    <div className="grid gap-4 p-5 xl:grid-cols-4 md:p-6">
      {columns.map((column) => (
        <section key={column.id} className="rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-[color:var(--text-secondary)]">
              {column.title}
            </h2>
            <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
              {column.items.length}
            </span>
          </div>

          <div className="space-y-3">
            {column.items.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-[color:var(--border-subtle)] px-4 py-6 text-sm text-[color:var(--text-muted)]">
                No cards here.
              </div>
            ) : (
              column.items.map((task) => {
                const selected = task.id === selectedTaskId;

                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask(task)}
                    className={`w-full rounded-[22px] border p-4 text-left transition ${
                      selected
                        ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]/50"
                        : "border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] hover:border-[color:var(--border-strong)]"
                    }`}
                  >
                    <p className="text-sm font-medium leading-6 text-[color:var(--text-primary)]">
                      {task.title}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
                        {task.owner ?? "Unassigned"}
                      </span>
                      <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
                        {formatDueDate(task.dueDate)}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-[color:var(--text-muted)]">
                      {task.meetingTitle}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function ContextPanel({
  task,
  meeting,
}: {
  task: ActionItemsLabTask | null;
  meeting: MeetingGroup | null;
}) {
  return (
    <aside className="border-t border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)]/65 p-6 xl:border-l xl:border-t-0">
      <div className="space-y-6 xl:sticky xl:top-8">
        {meeting ? (
          <section>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
              Meeting summary
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
              {meeting.title}
            </h2>
            <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
              {meeting.summary}
            </p>
          </section>
        ) : null}

        {task ? (
          <section className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
              Selected action item
            </p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-[color:var(--text-primary)]">
              {task.title}
            </h3>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">Owner</dt>
                <dd className="font-medium text-[color:var(--text-primary)]">
                  {task.owner ?? "Unassigned"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">Due date</dt>
                <dd className="font-medium text-[color:var(--text-primary)]">
                  {formatDueDate(task.dueDate)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">Status</dt>
                <dd className="font-medium text-[color:var(--text-primary)]">
                  {task.status === "complete" ? "Completed" : "Open"}
                </dd>
              </div>
            </dl>
          </section>
        ) : null}

        <section className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 text-[color:var(--text-muted)]" />
            <p className="text-sm leading-7 text-[color:var(--text-secondary)]">
              This pass is intentionally closer to Vinyl: meeting context drives
              the layout, and the action items sit inside that frame instead of
              floating as independent AI objects.
            </p>
          </div>
        </section>
      </div>
    </aside>
  );
}

export default function ActionItemsLab() {
  const [mode, setMode] = useState<ActionItemsLabMode>("workspace");
  const [filters, setFilters] = useState<ActionItemsLabFilters>(DEFAULT_FILTERS);
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const summary = useMemo(
    () => buildSummary(actionItemsLabMockData, TODAY),
    []
  );

  const filteredTasks = useMemo(
    () => filterTasks(actionItemsLabMockData, filters, TODAY),
    [filters]
  );

  const meetingGroups = useMemo(
    () => buildMeetingGroups(filteredTasks),
    [filteredTasks]
  );

  const selectedMeeting = useMemo(
    () =>
      meetingGroups.find((meeting) => meeting.id === selectedMeetingId) ??
      meetingGroups[0] ??
      null,
    [meetingGroups, selectedMeetingId]
  );

  const selectedTask = useMemo(
    () =>
      selectedMeeting?.items.find((task) => task.id === selectedTaskId) ??
      selectedMeeting?.items[0] ??
      filteredTasks[0] ??
      null,
    [filteredTasks, selectedMeeting, selectedTaskId]
  );

  const kanbanColumns = useMemo(
    () => buildKanbanColumns(filteredTasks, TODAY),
    [filteredTasks]
  );

  useEffect(() => {
    if (selectedMeetingId && meetingGroups.some((meeting) => meeting.id === selectedMeetingId)) {
      return;
    }
    setSelectedMeetingId(meetingGroups[0]?.id ?? null);
  }, [meetingGroups, selectedMeetingId]);

  useEffect(() => {
    if (selectedTaskId && selectedMeeting?.items.some((task) => task.id === selectedTaskId)) {
      return;
    }
    setSelectedTaskId(selectedMeeting?.items[0]?.id ?? filteredTasks[0]?.id ?? null);
  }, [filteredTasks, selectedMeeting, selectedTaskId]);

  return (
    <div className="min-h-screen bg-[color:var(--app-bg)] px-5 py-8 text-[color:var(--text-primary)] md:px-8">
      <div className="mx-auto max-w-[1520px]">
        <header className="mb-6 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[color:var(--text-muted)]">
              Browser-only action items lab
            </p>
            <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-[color:var(--text-primary)] md:text-[3.25rem]">
              Action items with the meeting as the anchor.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-8 text-[color:var(--text-secondary)]">
              This pass shifts away from the AI-dashboard look and leans into a
              Vinyl-style split view: choose the meeting first, then work through
              its context and extracted tasks together.
            </p>
          </div>

          <div className="flex flex-col gap-4 xl:items-end">
            <ModeToggle mode={mode} onChange={setMode} />
            <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-3 py-1.5 text-xs text-[color:var(--text-secondary)]">
              <CalendarRange className="h-3.5 w-3.5" />
              Snapshot date: Mar 31, 2026
            </div>
          </div>
        </header>

        <div className="space-y-4">
          <CompactSummary summary={summary} />
          <div className="rounded-[32px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] p-4 shadow-[var(--shadow-panel)]">
            <FiltersBar filters={filters} onChange={setFilters} />
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-[34px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-panel)]">
          {mode === "workspace" ? (
            <div className="grid xl:grid-cols-[280px_minmax(0,1fr)_320px]">
              <MeetingRail
                meetings={meetingGroups}
                selectedMeetingId={selectedMeeting?.id ?? null}
                onSelectMeeting={setSelectedMeetingId}
              />
              <MeetingWorkspace
                meeting={selectedMeeting}
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={(task) => setSelectedTaskId(task.id)}
              />
              <ContextPanel task={selectedTask} meeting={selectedMeeting} />
            </div>
          ) : (
            <KanbanView
              columns={kanbanColumns}
              selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={(task) => setSelectedTaskId(task.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
