# Action Items Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-only localhost prototype route that compares a production-style `Workspace` layout and `Kanban` layout for action items without changing the existing desktop app navigation or current Action Items page.

**Architecture:** Add a standalone Next.js route at `/action-items-lab` outside the protected shell so it is easy to open in a browser. Keep all prototype logic in `web/src/components/action-items-lab/`, back it with mock data plus pure selector functions for filtering, summaries, and mode-specific grouping, and render both layouts from the same stateful container with a right-side task detail drawer.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, shared CSS variables in `web/src/app/globals.css`, Vitest + Testing Library for new web tests.

---

## File Structure

### New files

- `web/src/app/action-items-lab/page.tsx`
  Browser-only preview route with no sidebar and no `AuthGuard`.
- `web/src/components/action-items-lab/types.ts`
  Shared prototype types for task records, filters, summary cards, workspace buckets, and kanban columns.
- `web/src/components/action-items-lab/mock-data.ts`
  Realistic mock action items with varied due dates, owners, and completion states.
- `web/src/components/action-items-lab/selectors.ts`
  Pure functions for filtering, summaries, workspace bucket grouping, and kanban column grouping.
- `web/src/components/action-items-lab/selectors.test.ts`
  Unit tests for the selector layer.
- `web/src/components/action-items-lab/ActionItemsLab.tsx`
  Stateful container that owns mode, filter, and selected-task state.
- `web/src/components/action-items-lab/ModeToggle.tsx`
  Segmented control for `Workspace` and `Kanban`.
- `web/src/components/action-items-lab/SummaryStrip.tsx`
  Summary cards for `Open`, `Due This Week`, `Overdue`, and `Completed`.
- `web/src/components/action-items-lab/FiltersBar.tsx`
  Shared search and filter controls styled to match the dashboard tokens.
- `web/src/components/action-items-lab/TaskDrawer.tsx`
  Right-side detail drawer for the selected task.
- `web/src/components/action-items-lab/WorkspaceView.tsx`
  Grouped execution-first view using due-date buckets.
- `web/src/components/action-items-lab/KanbanView.tsx`
  Planning-oriented board layout using shared filtered task state.
- `web/src/components/action-items-lab/ActionItemsLab.test.tsx`
  Component-level render and interaction tests for the route container.
- `web/vitest.config.ts`
  Vitest config with `@/` alias resolution and jsdom environment.
- `web/src/test/setup.ts`
  Testing Library and `jest-dom` setup for web tests.

### Modified files

- `web/package.json`
  Add test scripts and the minimum web-testing dev dependencies.

## Task 1: Add Web Test Harness And Selector Layer

**Files:**
- Modify: `web/package.json`
- Create: `web/vitest.config.ts`
- Create: `web/src/test/setup.ts`
- Create: `web/src/components/action-items-lab/types.ts`
- Create: `web/src/components/action-items-lab/mock-data.ts`
- Create: `web/src/components/action-items-lab/selectors.ts`
- Test: `web/src/components/action-items-lab/selectors.test.ts`

- [ ] **Step 1: Write the failing selector tests and test harness files**

Create `web/src/components/action-items-lab/selectors.test.ts`:

```tsx
import { describe, expect, it } from "vitest";
import { actionItemsLabMockData } from "@/components/action-items-lab/mock-data";
import {
  buildKanbanColumns,
  buildSummary,
  buildWorkspaceBuckets,
  filterTasks,
} from "@/components/action-items-lab/selectors";

const TODAY = new Date("2026-03-31T09:00:00.000Z");

describe("action items lab selectors", () => {
  it("builds summary counts from shared mock data", () => {
    expect(buildSummary(actionItemsLabMockData, TODAY)).toEqual({
      open: 8,
      dueThisWeek: 5,
      overdue: 2,
      completed: 3,
    });
  });

  it("filters by search, owner, status, and due bucket together", () => {
    const filtered = filterTasks(
      actionItemsLabMockData,
      {
        search: "deck",
        owner: "nina",
        status: "open",
        due: "week",
      },
      TODAY
    );

    expect(filtered.map((task) => task.id)).toEqual(["task-05"]);
  });

  it("groups tasks into due-date buckets for workspace mode", () => {
    const buckets = buildWorkspaceBuckets(actionItemsLabMockData, TODAY);

    expect(buckets.find((bucket) => bucket.id === "overdue")?.items.length).toBe(2);
    expect(buckets.find((bucket) => bucket.id === "today")?.items.length).toBe(1);
    expect(buckets.find((bucket) => bucket.id === "no-due-date")?.items.length).toBe(2);
  });

  it("groups tasks into kanban columns for planning mode", () => {
    const columns = buildKanbanColumns(actionItemsLabMockData, TODAY);

    expect(columns.map((column) => column.id)).toEqual([
      "needs-attention",
      "this-week",
      "planned",
      "done",
    ]);
    expect(columns.find((column) => column.id === "done")?.items.every((task) => task.status === "complete")).toBe(true);
  });
});
```

Modify `web/package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.2.0",
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "eslint": "^8",
    "eslint-config-next": "14.2.35",
    "jsdom": "^25.0.1",
    "postcss": "^8",
    "tailwindcss": "^3.4.1",
    "typescript": "^5",
    "vitest": "^2.1.8"
  }
}
```

Create `web/vitest.config.ts`:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

Create `web/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Run the selector test to verify it fails**

Run:

```bash
cd web
npm install
npm test -- src/components/action-items-lab/selectors.test.ts
```

Expected: FAIL with module resolution errors for missing `mock-data.ts` and `selectors.ts`.

- [ ] **Step 3: Write the minimal selector implementation and shared mock data**

Create `web/src/components/action-items-lab/types.ts`:

```ts
export type ActionItemsLabMode = "workspace" | "kanban";
export type ActionItemsLabStatusFilter = "all" | "open" | "complete";
export type ActionItemsLabDueFilter = "all" | "overdue" | "today" | "week" | "no-due-date";

export interface ActionItemsLabTask {
  id: string;
  title: string;
  owner: string | null;
  dueDate: string | null;
  status: "open" | "complete";
  meetingId: number;
  meetingTitle: string;
  excerpt: string;
}

export interface ActionItemsLabFilters {
  search: string;
  owner: string;
  status: ActionItemsLabStatusFilter;
  due: ActionItemsLabDueFilter;
}

export interface ActionItemsLabSummary {
  open: number;
  dueThisWeek: number;
  overdue: number;
  completed: number;
}

export interface ActionItemsLabBucket {
  id: "overdue" | "today" | "this-week" | "later" | "no-due-date";
  title: string;
  items: ActionItemsLabTask[];
}

export interface ActionItemsLabColumn {
  id: "needs-attention" | "this-week" | "planned" | "done";
  title: string;
  items: ActionItemsLabTask[];
}
```

Create `web/src/components/action-items-lab/mock-data.ts`:

```ts
import type { ActionItemsLabTask } from "./types";

export const actionItemsLabMockData: ActionItemsLabTask[] = [
  {
    id: "task-01",
    title: "Send revised onboarding checklist to finance and ops",
    owner: "Nina Torres",
    dueDate: "2026-03-28",
    status: "open",
    meetingId: 101,
    meetingTitle: "Operations weekly sync",
    excerpt: "Nina will send the revised onboarding checklist after procurement signs off.",
  },
  {
    id: "task-02",
    title: "Confirm Q2 vendor pricing before Thursday review",
    owner: "Marco Lim",
    dueDate: "2026-03-30",
    status: "open",
    meetingId: 102,
    meetingTitle: "Budget alignment review",
    excerpt: "Marco is following up with vendors to lock pricing ahead of the Thursday review.",
  },
  {
    id: "task-03",
    title: "Publish the finalized launch FAQ in the customer hub",
    owner: "Jamie Cruz",
    dueDate: "2026-03-31",
    status: "open",
    meetingId: 103,
    meetingTitle: "Launch readiness standup",
    excerpt: "Jamie owns the final FAQ draft and will post it once product signs off.",
  },
  {
    id: "task-04",
    title: "Create follow-up list for inactive beta accounts",
    owner: null,
    dueDate: "2026-04-01",
    status: "open",
    meetingId: 104,
    meetingTitle: "Growth pipeline review",
    excerpt: "The team needs a clean list of inactive beta accounts for outreach.",
  },
  {
    id: "task-05",
    title: "Update the board deck with retention callouts",
    owner: "Nina Torres",
    dueDate: "2026-04-02",
    status: "open",
    meetingId: 105,
    meetingTitle: "Exec metrics prep",
    excerpt: "Nina will refresh the board deck and highlight retention movement.",
  },
  {
    id: "task-06",
    title: "Draft customer email for the mobile release delay",
    owner: "Alden Reyes",
    dueDate: "2026-04-03",
    status: "open",
    meetingId: 106,
    meetingTitle: "Release risk review",
    excerpt: "Alden will prepare a customer-facing delay note for review.",
  },
  {
    id: "task-07",
    title: "Schedule legal review for the reseller agreement",
    owner: "Priya Santos",
    dueDate: "2026-04-10",
    status: "open",
    meetingId: 107,
    meetingTitle: "Partnerships sync",
    excerpt: "Legal review needs to happen before the new reseller agreement is sent.",
  },
  {
    id: "task-08",
    title: "Prepare examples for the internal AI usage policy",
    owner: null,
    dueDate: null,
    status: "open",
    meetingId: 108,
    meetingTitle: "AI governance workshop",
    excerpt: "The policy needs real examples so teams understand acceptable usage.",
  },
  {
    id: "task-09",
    title: "Share annotated competitor notes with product marketing",
    owner: "Lara Ong",
    dueDate: null,
    status: "open",
    meetingId: 109,
    meetingTitle: "Competitive intelligence review",
    excerpt: "Lara will package the annotated notes for product marketing.",
  },
  {
    id: "task-10",
    title: "Close open procurement checklist from March planning",
    owner: "Marco Lim",
    dueDate: "2026-03-27",
    status: "complete",
    meetingId: 110,
    meetingTitle: "March planning retro",
    excerpt: "Marco wrapped the remaining procurement checklist items.",
  },
  {
    id: "task-11",
    title: "Post retrospective notes in the team workspace",
    owner: "Jamie Cruz",
    dueDate: "2026-03-29",
    status: "complete",
    meetingId: 111,
    meetingTitle: "Sprint retrospective",
    excerpt: "Jamie posted the retro notes and tagged all action owners.",
  },
  {
    id: "task-12",
    title: "Finalize support escalation matrix for pilot launch",
    owner: "Alden Reyes",
    dueDate: "2026-04-05",
    status: "complete",
    meetingId: 112,
    meetingTitle: "Pilot launch readiness",
    excerpt: "The support escalation matrix is ready for the pilot launch.",
  },
];
```

Create `web/src/components/action-items-lab/selectors.ts`:

```ts
import type {
  ActionItemsLabBucket,
  ActionItemsLabColumn,
  ActionItemsLabFilters,
  ActionItemsLabSummary,
  ActionItemsLabTask,
} from "./types";

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function parseDueDate(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function dayDiff(dueDate: Date, today: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((startOfDay(dueDate).getTime() - startOfDay(today).getTime()) / msPerDay);
}

function matchesDueFilter(task: ActionItemsLabTask, due: ActionItemsLabFilters["due"], today: Date): boolean {
  const parsed = parseDueDate(task.dueDate);
  if (due === "all") return true;
  if (due === "no-due-date") return parsed === null;
  if (!parsed) return false;

  const diff = dayDiff(parsed, today);
  if (due === "overdue") return diff < 0 && task.status === "open";
  if (due === "today") return diff === 0;
  if (due === "week") return diff >= 0 && diff <= 6;
  return true;
}

export function filterTasks(tasks: ActionItemsLabTask[], filters: ActionItemsLabFilters, today: Date): ActionItemsLabTask[] {
  const search = filters.search.trim().toLowerCase();
  const owner = filters.owner.trim().toLowerCase();

  return tasks.filter((task) => {
    if (filters.status !== "all" && task.status !== filters.status) return false;
    if (!matchesDueFilter(task, filters.due, today)) return false;
    if (owner && !(task.owner ?? "").toLowerCase().includes(owner)) return false;
    if (!search) return true;

    const haystack = [task.title, task.meetingTitle, task.owner ?? "", task.excerpt]
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });
}

export function buildSummary(tasks: ActionItemsLabTask[], today: Date): ActionItemsLabSummary {
  return tasks.reduce<ActionItemsLabSummary>(
    (summary, task) => {
      const due = parseDueDate(task.dueDate);
      const diff = due ? dayDiff(due, today) : null;

      if (task.status === "complete") {
        summary.completed += 1;
        return summary;
      }

      summary.open += 1;
      if (diff !== null && diff < 0) summary.overdue += 1;
      if (diff !== null && diff >= 0 && diff <= 6) summary.dueThisWeek += 1;
      return summary;
    },
    { open: 0, dueThisWeek: 0, overdue: 0, completed: 0 }
  );
}

export function buildWorkspaceBuckets(tasks: ActionItemsLabTask[], today: Date): ActionItemsLabBucket[] {
  const buckets: ActionItemsLabBucket[] = [
    { id: "overdue", title: "Overdue", items: [] },
    { id: "today", title: "Today", items: [] },
    { id: "this-week", title: "This Week", items: [] },
    { id: "later", title: "Later", items: [] },
    { id: "no-due-date", title: "No Due Date", items: [] },
  ];

  for (const task of tasks) {
    if (task.status === "complete") continue;

    const due = parseDueDate(task.dueDate);
    if (!due) {
      buckets[4].items.push(task);
      continue;
    }

    const diff = dayDiff(due, today);
    if (diff < 0) buckets[0].items.push(task);
    else if (diff === 0) buckets[1].items.push(task);
    else if (diff <= 6) buckets[2].items.push(task);
    else buckets[3].items.push(task);
  }

  return buckets;
}

export function buildKanbanColumns(tasks: ActionItemsLabTask[], today: Date): ActionItemsLabColumn[] {
  const columns: ActionItemsLabColumn[] = [
    { id: "needs-attention", title: "Needs Attention", items: [] },
    { id: "this-week", title: "This Week", items: [] },
    { id: "planned", title: "Planned", items: [] },
    { id: "done", title: "Done", items: [] },
  ];

  for (const task of tasks) {
    if (task.status === "complete") {
      columns[3].items.push(task);
      continue;
    }

    const due = parseDueDate(task.dueDate);
    if (!due) {
      columns[2].items.push(task);
      continue;
    }

    const diff = dayDiff(due, today);
    if (diff <= 0 || task.owner === null) columns[0].items.push(task);
    else if (diff <= 6) columns[1].items.push(task);
    else columns[2].items.push(task);
  }

  return columns;
}
```

- [ ] **Step 4: Run the selector tests and lint to verify they pass**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/selectors.test.ts
npm run lint
```

Expected:

- `selectors.test.ts` PASS
- `next lint` reports no errors in the new selector files

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts web/src/test/setup.ts web/src/components/action-items-lab/types.ts web/src/components/action-items-lab/mock-data.ts web/src/components/action-items-lab/selectors.ts web/src/components/action-items-lab/selectors.test.ts
git commit -m "test: add action items lab selectors"
```

## Task 2: Build The Shared Lab Route, Header, Filters, And Drawer

**Files:**
- Create: `web/src/app/action-items-lab/page.tsx`
- Create: `web/src/components/action-items-lab/ActionItemsLab.tsx`
- Create: `web/src/components/action-items-lab/ModeToggle.tsx`
- Create: `web/src/components/action-items-lab/SummaryStrip.tsx`
- Create: `web/src/components/action-items-lab/FiltersBar.tsx`
- Create: `web/src/components/action-items-lab/TaskDrawer.tsx`
- Test: `web/src/components/action-items-lab/ActionItemsLab.test.tsx`

- [ ] **Step 1: Write the failing container test**

Create `web/src/components/action-items-lab/ActionItemsLab.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ActionItemsLab from "@/components/action-items-lab/ActionItemsLab";

describe("ActionItemsLab", () => {
  it("renders the shared shell and switches modes", () => {
    render(<ActionItemsLab />);

    expect(screen.getByRole("heading", { name: "Action Items" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Overdue")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));

    expect(screen.getByRole("button", { name: "Kanban" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
  });

  it("opens the detail drawer when a task is selected", () => {
    render(<ActionItemsLab />);

    fireEvent.click(screen.getByRole("button", { name: /Send revised onboarding checklist/i }));

    expect(screen.getByRole("complementary", { name: "Task details" })).toBeInTheDocument();
    expect(screen.getByText("Operations weekly sync")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the container test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx
```

Expected: FAIL because `ActionItemsLab.tsx` and the shared UI components do not exist yet.

- [ ] **Step 3: Write the shared route and container implementation**

Create `web/src/app/action-items-lab/page.tsx`:

```tsx
import ActionItemsLab from "@/components/action-items-lab/ActionItemsLab";

export default function ActionItemsLabPage() {
  return <ActionItemsLab />;
}
```

Create `web/src/components/action-items-lab/ActionItemsLab.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { actionItemsLabMockData } from "./mock-data";
import { buildSummary, filterTasks } from "./selectors";
import type { ActionItemsLabFilters, ActionItemsLabMode, ActionItemsLabTask } from "./types";
import FiltersBar from "./FiltersBar";
import KanbanView from "./KanbanView";
import ModeToggle from "./ModeToggle";
import SummaryStrip from "./SummaryStrip";
import TaskDrawer from "./TaskDrawer";
import WorkspaceView from "./WorkspaceView";

const TODAY = new Date("2026-03-31T09:00:00.000Z");

const DEFAULT_FILTERS: ActionItemsLabFilters = {
  search: "",
  owner: "",
  status: "all",
  due: "all",
};

export default function ActionItemsLab() {
  const [mode, setMode] = useState<ActionItemsLabMode>("workspace");
  const [filters, setFilters] = useState<ActionItemsLabFilters>(DEFAULT_FILTERS);
  const [selectedTask, setSelectedTask] = useState<ActionItemsLabTask | null>(null);

  const summary = useMemo(() => buildSummary(actionItemsLabMockData, TODAY), []);
  const filteredTasks = useMemo(
    () => filterTasks(actionItemsLabMockData, filters, TODAY),
    [filters]
  );

  return (
    <div className="min-h-screen bg-[color:var(--app-bg)] px-6 py-8 text-[color:var(--text-primary)] md:px-10">
      <div className="mx-auto grid max-w-[1480px] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <header className="surface-panel rounded-[32px] p-6 md:p-7">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
                  Action Items Lab
                </p>
                <h1 className="text-3xl font-semibold tracking-tight">Action Items</h1>
                <p className="max-w-2xl text-sm leading-7 text-[color:var(--text-secondary)]">
                  Compare an execution-first workspace against a planning-style board using the same extracted meeting tasks.
                </p>
              </div>
              <ModeToggle mode={mode} onModeChange={setMode} />
            </div>
          </header>

          <SummaryStrip summary={summary} />
          <FiltersBar filters={filters} onFiltersChange={setFilters} />

          {mode === "workspace" ? (
            <WorkspaceView tasks={filteredTasks} today={TODAY} selectedTaskId={selectedTask?.id ?? null} onSelectTask={setSelectedTask} />
          ) : (
            <KanbanView tasks={filteredTasks} today={TODAY} selectedTaskId={selectedTask?.id ?? null} onSelectTask={setSelectedTask} />
          )}
        </div>

        <TaskDrawer task={selectedTask} onClose={() => setSelectedTask(null)} />
      </div>
    </div>
  );
}
```

Create `web/src/components/action-items-lab/ModeToggle.tsx`:

```tsx
import type { ActionItemsLabMode } from "./types";

export default function ModeToggle({
  mode,
  onModeChange,
}: {
  mode: ActionItemsLabMode;
  onModeChange: (mode: ActionItemsLabMode) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] p-1">
      {(["workspace", "kanban"] as const).map((value) => {
        const active = value === mode;
        const label = value === "workspace" ? "Workspace" : "Kanban";

        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onModeChange(value)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              active
                ? "bg-[color:var(--surface-elevated)] text-[color:var(--text-primary)] shadow-[var(--shadow-soft)]"
                : "text-[color:var(--text-secondary)]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
```

Create `web/src/components/action-items-lab/SummaryStrip.tsx`:

```tsx
import type { ActionItemsLabSummary } from "./types";

const ITEMS = [
  { key: "open", label: "Open" },
  { key: "dueThisWeek", label: "Due This Week" },
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
] as const;

export default function SummaryStrip({ summary }: { summary: ActionItemsLabSummary }) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {ITEMS.map((item) => (
        <article key={item.key} className="surface-card rounded-[28px] p-5 shadow-[var(--shadow-soft)]">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
            {item.label}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
            {summary[item.key]}
          </p>
        </article>
      ))}
    </section>
  );
}
```

Create `web/src/components/action-items-lab/FiltersBar.tsx`:

```tsx
import type { ActionItemsLabDueFilter, ActionItemsLabFilters, ActionItemsLabStatusFilter } from "./types";

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

export default function FiltersBar({
  filters,
  onFiltersChange,
}: {
  filters: ActionItemsLabFilters;
  onFiltersChange: (filters: ActionItemsLabFilters) => void;
}) {
  const update = <K extends keyof ActionItemsLabFilters>(key: K, value: ActionItemsLabFilters[K]) =>
    onFiltersChange({ ...filters, [key]: value });

  return (
    <section className="surface-panel rounded-[30px] p-5">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(180px,0.8fr)_180px_200px]">
        <input
          type="text"
          value={filters.search}
          onChange={(event) => update("search", event.target.value)}
          placeholder="Search tasks, meetings, or context"
          className="h-12 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
        />
        <input
          type="text"
          value={filters.owner}
          onChange={(event) => update("owner", event.target.value)}
          placeholder="Filter by owner"
          className="h-12 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
        />
        <select
          value={filters.status}
          onChange={(event) => update("status", event.target.value as ActionItemsLabStatusFilter)}
          className="h-12 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={filters.due}
          onChange={(event) => update("due", event.target.value as ActionItemsLabDueFilter)}
          className="h-12 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
        >
          {DUE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
```

Create `web/src/components/action-items-lab/TaskDrawer.tsx`:

```tsx
import type { ActionItemsLabTask } from "./types";

export default function TaskDrawer({
  task,
  onClose,
}: {
  task: ActionItemsLabTask | null;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Task details"
      className="surface-panel sticky top-8 hidden h-[calc(100vh-4rem)] rounded-[32px] p-6 xl:block"
    >
      {task ? (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                Selected task
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight">{task.title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[color:var(--border-subtle)] px-3 py-1.5 text-sm text-[color:var(--text-secondary)]"
            >
              Close
            </button>
          </div>

          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="text-[color:var(--text-muted)]">Owner</dt>
              <dd className="mt-1 text-[color:var(--text-primary)]">{task.owner ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Due date</dt>
              <dd className="mt-1 text-[color:var(--text-primary)]">{task.dueDate ?? "No due date"}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Status</dt>
              <dd className="mt-1 text-[color:var(--text-primary)]">{task.status === "complete" ? "Completed" : "Open"}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Source meeting</dt>
              <dd className="mt-1 text-[color:var(--text-primary)]">{task.meetingTitle}</dd>
            </div>
          </dl>

          <div className="mt-6 rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
              Meeting context
            </p>
            <p className="mt-3 text-sm leading-7 text-[color:var(--text-secondary)]">{task.excerpt}</p>
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-center">
          <div>
            <p className="text-sm font-medium text-[color:var(--text-primary)]">Select a task</p>
            <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
              Compare layouts, then open a task to inspect its execution context.
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: Run the new tests and lint**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx src/components/action-items-lab/selectors.test.ts
npm run lint
```

Expected:

- container test passes
- selector test still passes
- lint passes for the route, header, filters, and drawer

- [ ] **Step 5: Commit**

```bash
git add web/src/app/action-items-lab/page.tsx web/src/components/action-items-lab/ActionItemsLab.tsx web/src/components/action-items-lab/ModeToggle.tsx web/src/components/action-items-lab/SummaryStrip.tsx web/src/components/action-items-lab/FiltersBar.tsx web/src/components/action-items-lab/TaskDrawer.tsx web/src/components/action-items-lab/ActionItemsLab.test.tsx
git commit -m "feat: add action items lab shell"
```

## Task 3: Implement Workspace Mode

**Files:**
- Create: `web/src/components/action-items-lab/WorkspaceView.tsx`
- Modify: `web/src/components/action-items-lab/ActionItemsLab.tsx`
- Test: `web/src/components/action-items-lab/ActionItemsLab.test.tsx`

- [ ] **Step 1: Extend the failing UI test for workspace rendering**

Update `web/src/components/action-items-lab/ActionItemsLab.test.tsx`:

```tsx
it("renders workspace buckets and keeps the selected task highlighted", () => {
  render(<ActionItemsLab />);

  expect(screen.getByText("Today")).toBeInTheDocument();
  expect(screen.getByText("This Week")).toBeInTheDocument();

  const card = screen.getByRole("button", { name: /Publish the finalized launch FAQ/i });
  fireEvent.click(card);

  expect(card).toHaveAttribute("data-selected", "true");
  expect(screen.getByText("Launch readiness standup")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the workspace-focused test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx
```

Expected: FAIL because `WorkspaceView.tsx` has not rendered bucket sections or selected-state markup yet.

- [ ] **Step 3: Implement the workspace execution view**

Create `web/src/components/action-items-lab/WorkspaceView.tsx`:

```tsx
import { buildWorkspaceBuckets } from "./selectors";
import type { ActionItemsLabTask } from "./types";

function formatDueDate(value: string | null): string {
  if (!value) return "No due date";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function WorkspaceView({
  tasks,
  today,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: ActionItemsLabTask[];
  today: Date;
  selectedTaskId: string | null;
  onSelectTask: (task: ActionItemsLabTask) => void;
}) {
  const buckets = buildWorkspaceBuckets(tasks, today);

  return (
    <section className="space-y-4">
      {buckets.map((bucket) => (
        <article key={bucket.id} className="surface-panel rounded-[30px] p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{bucket.title}</h2>
              <p className="text-sm text-[color:var(--text-secondary)]">
                {bucket.items.length} task{bucket.items.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          {bucket.items.length === 0 ? (
            <p className="rounded-[24px] border border-dashed border-[color:var(--border-subtle)] px-4 py-5 text-sm text-[color:var(--text-muted)]">
              No tasks in this bucket.
            </p>
          ) : (
            <div className="space-y-3">
              {bucket.items.map((task) => {
                const selected = task.id === selectedTaskId;
                return (
                  <button
                    key={task.id}
                    type="button"
                    data-selected={selected ? "true" : "false"}
                    aria-pressed={selected}
                    onClick={() => onSelectTask(task)}
                    className={`w-full rounded-[26px] border p-4 text-left transition ${
                      selected
                        ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                        : "border-[color:var(--border-subtle)] bg-[color:var(--surface)] hover:border-[color:var(--border-strong)]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--border-strong)] text-[10px]">
                            {task.status === "complete" ? "✓" : ""}
                          </span>
                          <p className="text-sm font-medium text-[color:var(--text-primary)]">{task.title}</p>
                        </div>
                        <p className="text-sm leading-7 text-[color:var(--text-secondary)]">{task.excerpt}</p>
                      </div>
                      <div className="min-w-[140px] space-y-2 text-right text-xs text-[color:var(--text-secondary)]">
                        <p>{task.owner ?? "Unassigned"}</p>
                        <p>{formatDueDate(task.dueDate)}</p>
                        <p className="text-[color:var(--accent-text)]">{task.meetingTitle}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
```

Ensure `web/src/components/action-items-lab/ActionItemsLab.tsx` keeps the existing workspace branch:

```tsx
{mode === "workspace" ? (
  <WorkspaceView
    tasks={filteredTasks}
    today={TODAY}
    selectedTaskId={selectedTask?.id ?? null}
    onSelectTask={setSelectedTask}
  />
) : (
  <KanbanView
    tasks={filteredTasks}
    today={TODAY}
    selectedTaskId={selectedTask?.id ?? null}
    onSelectTask={setSelectedTask}
  />
)}
```

- [ ] **Step 4: Run the updated tests and lint**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx src/components/action-items-lab/selectors.test.ts
npm run lint
```

Expected:

- workspace assertions pass
- prior shell and selector assertions still pass
- no lint issues in `WorkspaceView.tsx`

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items-lab/WorkspaceView.tsx web/src/components/action-items-lab/ActionItemsLab.tsx web/src/components/action-items-lab/ActionItemsLab.test.tsx
git commit -m "feat: add workspace action items view"
```

## Task 4: Implement Kanban Mode

**Files:**
- Create: `web/src/components/action-items-lab/KanbanView.tsx`
- Modify: `web/src/components/action-items-lab/ActionItemsLab.test.tsx`

- [ ] **Step 1: Extend the failing test for kanban rendering**

Update `web/src/components/action-items-lab/ActionItemsLab.test.tsx`:

```tsx
it("renders kanban columns from the same filtered task set", () => {
  render(<ActionItemsLab />);

  fireEvent.click(screen.getByRole("button", { name: "Kanban" }));

  expect(screen.getByText("Needs Attention")).toBeInTheDocument();
  expect(screen.getByText("Planned")).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText("Search tasks, meetings, or context"), {
    target: { value: "policy" },
  });

  expect(screen.getByRole("button", { name: /Prepare examples for the internal AI usage policy/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the kanban-focused test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx
```

Expected: FAIL because `KanbanView.tsx` does not exist and the `Kanban` branch cannot render columns.

- [ ] **Step 3: Implement the kanban planning view**

Create `web/src/components/action-items-lab/KanbanView.tsx`:

```tsx
import { buildKanbanColumns } from "./selectors";
import type { ActionItemsLabTask } from "./types";

function formatChip(label: string): string {
  return label.trim();
}

export default function KanbanView({
  tasks,
  today,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: ActionItemsLabTask[];
  today: Date;
  selectedTaskId: string | null;
  onSelectTask: (task: ActionItemsLabTask) => void;
}) {
  const columns = buildKanbanColumns(tasks, today);

  return (
    <section className="grid gap-4 xl:grid-cols-4">
      {columns.map((column) => (
        <article key={column.id} className="surface-panel rounded-[30px] p-4">
          <div className="mb-4">
            <h2 className="text-base font-semibold tracking-tight">{column.title}</h2>
            <p className="text-sm text-[color:var(--text-secondary)]">
              {column.items.length} card{column.items.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="space-y-3">
            {column.items.map((task) => {
              const selected = task.id === selectedTaskId;

              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onSelectTask(task)}
                  className={`w-full rounded-[24px] border p-4 text-left transition ${
                    selected
                      ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                      : "border-[color:var(--border-subtle)] bg-[color:var(--surface)] hover:border-[color:var(--border-strong)]"
                  }`}
                >
                  <p className="text-sm font-medium leading-6 text-[color:var(--text-primary)]">{task.title}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 text-xs text-[color:var(--text-secondary)]">
                      {formatChip(task.owner ?? "Unassigned")}
                    </span>
                    <span className="rounded-full bg-[color:var(--accent-soft)] px-2.5 py-1 text-xs text-[color:var(--accent-text)]">
                      {formatChip(task.dueDate ?? "No due date")}
                    </span>
                  </div>
                  <p className="mt-4 text-xs text-[color:var(--text-muted)]">{task.meetingTitle}</p>
                </button>
              );
            })}
          </div>
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Run the full lab test suite and lint**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx src/components/action-items-lab/selectors.test.ts
npm run lint
```

Expected:

- both `Workspace` and `Kanban` interaction tests pass
- selector tests continue to pass
- lint passes for `KanbanView.tsx`

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items-lab/KanbanView.tsx web/src/components/action-items-lab/ActionItemsLab.test.tsx
git commit -m "feat: add kanban action items view"
```

## Task 5: Verify The Browser Preview Route

**Files:**
- Modify: `web/src/components/action-items-lab/ActionItemsLab.tsx` (only if polish fixes are required during verification)

- [ ] **Step 1: Run the full automated checks**

Run:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx src/components/action-items-lab/selectors.test.ts
npm run lint
```

Expected:

- test suite passes
- lint passes

- [ ] **Step 2: Start the browser preview route**

Run:

```bash
cd web
npm run dev
```

Open:

```text
http://localhost:3000/action-items-lab
```

Expected:

- page loads without the desktop app shell
- header, summary strip, filters, and drawer render with the shared theme tokens
- `Workspace` is the default selected mode

- [ ] **Step 3: Manually verify the prototype behavior**

Check:

```text
1. Switching between Workspace and Kanban keeps the same filter state.
2. Workspace shows Overdue, Today, This Week, Later, and No Due Date sections.
3. Kanban shows Needs Attention, This Week, Planned, and Done.
4. Light mode controls match the main dashboard styling instead of raw gray inputs.
5. Clicking any task updates the right-side drawer with owner, due date, meeting title, and context.
```

Expected: all five checks pass without layout breakage at desktop widths.

- [ ] **Step 4: Apply any verification-driven polish and rerun checks**

If Step 3 reveals spacing or state bugs, update `web/src/components/action-items-lab/ActionItemsLab.tsx` or the affected view component, then rerun:

```bash
cd web
npm test -- src/components/action-items-lab/ActionItemsLab.test.tsx src/components/action-items-lab/selectors.test.ts
npm run lint
```

Expected: final checks pass after any last-mile polish.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/action-items-lab/page.tsx web/src/components/action-items-lab
git commit -m "feat: add browser action items lab prototype"
```

## Self-Review

### Spec coverage

- Browser-only localhost route: covered by Task 2 route creation and Task 5 browser verification.
- No desktop navigation changes: preserved by creating `web/src/app/action-items-lab/page.tsx` outside the protected shell and touching no sidebar files.
- Shared summary strip and filter row: covered by Task 2.
- Workspace mode with due-date buckets: covered by Task 3.
- Kanban mode with planning columns: covered by Task 4.
- Mock-data-driven comparison: covered by Task 1.
- Right-side detail drawer: covered by Task 2 and exercised in tests.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Each task includes exact file paths, commands, and expected outcomes.
- Testing steps are concrete and not deferred.

### Type consistency

- Route path is consistently `/action-items-lab`.
- Shared types use `ActionItemsLabTask`, `ActionItemsLabFilters`, `ActionItemsLabSummary`, `ActionItemsLabBucket`, and `ActionItemsLabColumn` consistently across tasks.
- Mode names are consistently `workspace` and `kanban`.
