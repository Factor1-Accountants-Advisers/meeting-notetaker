# Action Items Vinyl Split View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Action Items table page with a meeting-context-first split view that aggregates action items across the signed-in user’s visible meetings while staying visually aligned with the existing app shell.

**Architecture:** Keep the route at `web/src/app/(protected)/action-items/page.tsx`, but replace its current raw table layout with a three-pane split view: a meeting rail on the left, a selected-meeting action item list in the center, and a context/detail pane on the right. Reuse the existing `useActionItems` API hook and `updateActionItem` mutation, add small view-model helpers for grouping action items by source meeting, and create focused UI components under `web/src/components/action-items/` for the production implementation.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, SWR, Tailwind CSS, shared CSS token utilities from `web/src/app/globals.css`, existing action-item update API.

---

## File Structure

### New files

- `web/src/components/action-items/types.ts`
  Local view-model types for grouped meetings and selected-row metadata.
- `web/src/components/action-items/selectors.ts`
  Pure helpers to filter action items by owner/status/search and group them into meeting-centric view models.
- `web/src/components/action-items/MeetingRail.tsx`
  Left pane listing meetings that currently contribute action items to the signed-in user’s inbox.
- `web/src/components/action-items/MeetingActionItemsView.tsx`
  Center pane showing the selected meeting’s action items and inline editing/toggle actions.
- `web/src/components/action-items/ActionItemContextPanel.tsx`
  Right pane with selected action item metadata and source meeting context.

### Modified files

- `web/src/app/(protected)/action-items/page.tsx`
  Replace the current dark hardcoded filter row and table-only rendering with the split layout container.
- `web/src/components/ActionItemsTable.tsx`
  Either retire from the route or reduce to meeting-detail-only usage. If retained for meeting detail pages, do not use it in the new `/action-items` layout.
- `web/src/lib/api.ts`
  Keep current hooks, but add optional local convenience helpers only if the page needs them.

## Scope Notes

This implementation intentionally excludes the following mockup-only elements:

- top summary pill strip (`Open`, `Due This Week`, `Overdue`, `Completed`)
- `Workspace / Kanban` toggle
- `Snapshot date` chip
- browser-lab explainer copy such as `Browser-only action items lab`

The production page is a single `Action Items` view, not a concept comparison surface.

## Task 1: Add Meeting-Centric View Models And Selectors

**Files:**
- Create: `web/src/components/action-items/types.ts`
- Create: `web/src/components/action-items/selectors.ts`

- [ ] **Step 1: Write the failing selector test file**

Create `web/src/components/action-items/selectors.test.ts`:

```tsx
import { describe, expect, it } from "vitest";
import { buildMeetingGroups, filterActionItems } from "@/components/action-items/selectors";
import type { ActionItem } from "@/types";

const items: ActionItem[] = [
  {
    id: 1,
    meeting_id: 100,
    description: "Send revised onboarding checklist",
    owner_name: "Nina Torres",
    owner_email: null,
    due_date: "2026-03-28",
    status: "open",
    created_at: "2026-03-28T08:00:00Z",
    updated_at: "2026-03-28T08:00:00Z",
  },
  {
    id: 2,
    meeting_id: 100,
    description: "Confirm vendor pricing",
    owner_name: "Marco Lim",
    owner_email: null,
    due_date: "2026-03-30",
    status: "open",
    created_at: "2026-03-28T08:00:00Z",
    updated_at: "2026-03-28T08:00:00Z",
  },
  {
    id: 3,
    meeting_id: 101,
    description: "Publish launch FAQ",
    owner_name: "Jamie Cruz",
    owner_email: null,
    due_date: "2026-03-31",
    status: "complete",
    created_at: "2026-03-28T08:00:00Z",
    updated_at: "2026-03-28T08:00:00Z",
  },
];

const titles = new Map<number, string>([
  [100, "Operations weekly sync"],
  [101, "Launch readiness standup"],
]);

describe("action items selectors", () => {
  it("filters items by owner, status, and search text", () => {
    const filtered = filterActionItems(items, {
      owner: "nina",
      status: "open",
      search: "checklist",
    });

    expect(filtered.map((item) => item.id)).toEqual([1]);
  });

  it("groups filtered items by source meeting", () => {
    const groups = buildMeetingGroups(items, titles);

    expect(groups.map((group) => group.meetingId)).toEqual([100, 101]);
    expect(groups[0].openCount).toBe(2);
    expect(groups[0].title).toBe("Operations weekly sync");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items/selectors.test.ts
```

Expected: FAIL because `web/src/components/action-items/selectors.ts` does not exist yet.

- [ ] **Step 3: Write minimal selector implementation**

Create `web/src/components/action-items/types.ts`:

```ts
import type { ActionItem } from "@/types";

export interface ActionItemsPageFilters {
  owner: string;
  status: "all" | "open" | "complete";
  search: string;
}

export interface MeetingActionItemsGroup {
  meetingId: number;
  title: string;
  items: ActionItem[];
  openCount: number;
  completedCount: number;
  owners: string[];
}
```

Create `web/src/components/action-items/selectors.ts`:

```ts
import type { ActionItem } from "@/types";
import type { ActionItemsPageFilters, MeetingActionItemsGroup } from "./types";

export function filterActionItems(
  items: ActionItem[],
  filters: ActionItemsPageFilters
): ActionItem[] {
  const owner = filters.owner.trim().toLowerCase();
  const search = filters.search.trim().toLowerCase();

  return items.filter((item) => {
    if (filters.status !== "all" && item.status !== filters.status) return false;
    if (owner && !(item.owner_name ?? "").toLowerCase().includes(owner)) return false;
    if (!search) return true;

    return [item.description, item.owner_name ?? ""].join(" ").toLowerCase().includes(search);
  });
}

export function buildMeetingGroups(
  items: ActionItem[],
  titles: Map<number, string>
): MeetingActionItemsGroup[] {
  const groups = new Map<number, MeetingActionItemsGroup>();

  for (const item of items) {
    const current = groups.get(item.meeting_id);
    if (current) {
      current.items.push(item);
      current.openCount += item.status === "open" ? 1 : 0;
      current.completedCount += item.status === "complete" ? 1 : 0;
      if (item.owner_name && !current.owners.includes(item.owner_name)) {
        current.owners.push(item.owner_name);
      }
      continue;
    }

    groups.set(item.meeting_id, {
      meetingId: item.meeting_id,
      title: titles.get(item.meeting_id) ?? `Meeting ${item.meeting_id}`,
      items: [item],
      openCount: item.status === "open" ? 1 : 0,
      completedCount: item.status === "complete" ? 1 : 0,
      owners: item.owner_name ? [item.owner_name] : [],
    });
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return a.title.localeCompare(b.title);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd web
npm test -- src/components/action-items/selectors.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items/types.ts web/src/components/action-items/selectors.ts web/src/components/action-items/selectors.test.ts
git commit -m "feat: add action items meeting grouping selectors"
```

## Task 2: Build The Left Meeting Rail

**Files:**
- Create: `web/src/components/action-items/MeetingRail.tsx`
- Modify: `web/src/app/(protected)/action-items/page.tsx`

- [ ] **Step 1: Write the failing render test**

Create `web/src/components/action-items/MeetingRail.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MeetingRail from "@/components/action-items/MeetingRail";

const groups = [
  {
    meetingId: 100,
    title: "Operations weekly sync",
    items: [],
    openCount: 2,
    completedCount: 0,
    owners: ["Nina Torres", "Marco Lim"],
  },
];

describe("MeetingRail", () => {
  it("renders meeting cards and notifies selection", () => {
    const onSelect = vi.fn();
    render(
      <MeetingRail groups={groups} selectedMeetingId={100} onSelectMeeting={onSelect} />
    );

    expect(screen.getByText("Operations weekly sync")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Operations weekly sync/i }));
    expect(onSelect).toHaveBeenCalledWith(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items/MeetingRail.test.tsx
```

Expected: FAIL because `MeetingRail.tsx` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/action-items/MeetingRail.tsx`:

```tsx
import type { MeetingActionItemsGroup } from "./types";

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
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
        Meetings
      </p>
      <div className="mt-4 space-y-2">
        {groups.map((group) => {
          const active = group.meetingId === selectedMeetingId;
          return (
            <button
              key={group.meetingId}
              type="button"
              onClick={() => onSelectMeeting(group.meetingId)}
              className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                active
                  ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-soft)]"
                  : "border-transparent hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--surface)]"
              }`}
            >
              <p className="text-sm font-medium text-[color:var(--text-primary)]">
                {group.title}
              </p>
              <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                {group.openCount} open · {group.completedCount} completed
              </p>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd web
npm test -- src/components/action-items/MeetingRail.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items/MeetingRail.tsx web/src/components/action-items/MeetingRail.test.tsx
git commit -m "feat: add action items meeting rail"
```

## Task 3: Build The Center Meeting Action Items Pane

**Files:**
- Create: `web/src/components/action-items/MeetingActionItemsView.tsx`
- Modify: `web/src/components/ActionItemsTable.tsx`

- [ ] **Step 1: Write the failing component test**

Create `web/src/components/action-items/MeetingActionItemsView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MeetingActionItemsView from "@/components/action-items/MeetingActionItemsView";
import type { ActionItem } from "@/types";

const items: ActionItem[] = [
  {
    id: 1,
    meeting_id: 100,
    description: "Send revised onboarding checklist",
    owner_name: "Nina Torres",
    owner_email: null,
    due_date: "2026-03-28",
    status: "open",
    created_at: "2026-03-28T08:00:00Z",
    updated_at: "2026-03-28T08:00:00Z",
  },
];

describe("MeetingActionItemsView", () => {
  it("renders the selected meeting title and its tasks", () => {
    render(
      <MeetingActionItemsView
        meetingTitle="Operations weekly sync"
        items={items}
        selectedActionItemId={1}
        onSelectActionItem={() => {}}
      />
    );

    expect(screen.getByText("Operations weekly sync")).toBeInTheDocument();
    expect(screen.getByText("Send revised onboarding checklist")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items/MeetingActionItemsView.test.tsx
```

Expected: FAIL because `MeetingActionItemsView.tsx` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/action-items/MeetingActionItemsView.tsx`:

```tsx
import type { ActionItem } from "@/types";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "No due date";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
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
    <section className="p-5 md:p-6">
      <h2 className="text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
        {meetingTitle}
      </h2>
      <div className="mt-6 overflow-hidden rounded-[26px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)]">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectActionItem(item.id)}
            className={`grid w-full gap-3 border-l-2 px-4 py-3 text-left transition md:grid-cols-[minmax(0,1fr)_120px_110px] ${
              item.id === selectedActionItemId
                ? "border-l-[color:var(--accent)] bg-[color:var(--accent-soft)]/50"
                : "border-l-transparent hover:bg-[color:var(--surface-soft)]/70"
            } ${index > 0 ? "border-t border-[color:var(--border-subtle)]" : ""}`}
          >
            <div className="text-sm font-medium text-[color:var(--text-primary)]">
              {item.description}
            </div>
            <div className="text-sm text-[color:var(--text-secondary)]">
              {item.owner_name ?? "Unassigned"}
            </div>
            <div className="text-sm text-[color:var(--text-primary)]">
              {formatDate(item.due_date)}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd web
npm test -- src/components/action-items/MeetingActionItemsView.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items/MeetingActionItemsView.tsx web/src/components/action-items/MeetingActionItemsView.test.tsx
git commit -m "feat: add meeting action items view"
```

## Task 4: Build The Right Context Pane

**Files:**
- Create: `web/src/components/action-items/ActionItemContextPanel.tsx`

- [ ] **Step 1: Write the failing component test**

Create `web/src/components/action-items/ActionItemContextPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ActionItemContextPanel from "@/components/action-items/ActionItemContextPanel";

describe("ActionItemContextPanel", () => {
  it("renders source meeting and selected action item details", () => {
    render(
      <ActionItemContextPanel
        meetingTitle="Operations weekly sync"
        meetingSummary="Nina will send the revised onboarding checklist."
        actionItem={{
          id: 1,
          description: "Send revised onboarding checklist",
          owner_name: "Nina Torres",
          due_date: "2026-03-28",
          status: "open",
        }}
      />
    );

    expect(screen.getByText("Operations weekly sync")).toBeInTheDocument();
    expect(screen.getByText("Send revised onboarding checklist")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd web
npm test -- src/components/action-items/ActionItemContextPanel.test.tsx
```

Expected: FAIL because `ActionItemContextPanel.tsx` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/action-items/ActionItemContextPanel.tsx`:

```tsx
export default function ActionItemContextPanel({
  meetingTitle,
  meetingSummary,
  actionItem,
}: {
  meetingTitle: string;
  meetingSummary: string;
  actionItem: {
    id: number;
    description: string;
    owner_name: string | null;
    due_date: string | null;
    status: string;
  } | null;
}) {
  return (
    <aside className="border-t border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)]/65 p-6 xl:border-l xl:border-t-0">
      <div className="space-y-6 xl:sticky xl:top-8">
        <section>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
            Meeting summary
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
            {meetingTitle}
          </h2>
          <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
            {meetingSummary}
          </p>
        </section>

        {actionItem ? (
          <section className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
              Selected action item
            </p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-[color:var(--text-primary)]">
              {actionItem.description}
            </h3>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">Owner</dt>
                <dd className="font-medium text-[color:var(--text-primary)]">
                  {actionItem.owner_name ?? "Unassigned"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[color:var(--text-secondary)]">Status</dt>
                <dd className="font-medium text-[color:var(--text-primary)]">
                  {actionItem.status}
                </dd>
              </div>
            </dl>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd web
npm test -- src/components/action-items/ActionItemContextPanel.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items/ActionItemContextPanel.tsx web/src/components/action-items/ActionItemContextPanel.test.tsx
git commit -m "feat: add action item context panel"
```

## Task 5: Integrate The Production Action Items Route

**Files:**
- Modify: `web/src/app/(protected)/action-items/page.tsx`
- Modify: `web/src/lib/api.ts` (only if a small helper is required)

- [ ] **Step 1: Write the failing page test**

Create `web/src/app/(protected)/action-items/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ActionItemsPage from "./page";

vi.mock("@/lib/api", () => ({
  useActionItems: () => ({
    data: {
      items: [
        {
          id: 1,
          meeting_id: 100,
          description: "Send revised onboarding checklist",
          owner_name: "Nina Torres",
          owner_email: null,
          due_date: "2026-03-28",
          status: "open",
          created_at: "2026-03-28T08:00:00Z",
          updated_at: "2026-03-28T08:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      per_page: 100,
      has_next: false,
    },
    error: null,
    isLoading: false,
  }),
}));

describe("ActionItemsPage", () => {
  it("renders the split-view heading and action item content", () => {
    render(<ActionItemsPage />);

    expect(screen.getByRole("heading", { name: "Action Items" })).toBeInTheDocument();
    expect(screen.getByText("Send revised onboarding checklist")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd web
npm test -- "src/app/(protected)/action-items/page.test.tsx"
```

Expected: FAIL because the old table page does not render the new split-view structure or testable grouped content.

- [ ] **Step 3: Write minimal route integration**

Modify `web/src/app/(protected)/action-items/page.tsx` to:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import ActionItemContextPanel from "@/components/action-items/ActionItemContextPanel";
import MeetingActionItemsView from "@/components/action-items/MeetingActionItemsView";
import MeetingRail from "@/components/action-items/MeetingRail";
import { buildMeetingGroups, filterActionItems } from "@/components/action-items/selectors";
import type { ActionItemsPageFilters } from "@/components/action-items/types";
import { useActionItems } from "@/lib/api";

const DEFAULT_FILTERS: ActionItemsPageFilters = {
  owner: "",
  status: "all",
  search: "",
};

export default function ActionItemsPage() {
  const [filters, setFilters] = useState<ActionItemsPageFilters>(DEFAULT_FILTERS);
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null);
  const [selectedActionItemId, setSelectedActionItemId] = useState<number | null>(null);
  const { data, error, isLoading } = useActionItems(1, 100);

  const filteredItems = useMemo(
    () => filterActionItems(data?.items ?? [], filters),
    [data?.items, filters]
  );

  const meetingTitles = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of filteredItems) {
      map.set(item.meeting_id, `Meeting ${item.meeting_id}`);
    }
    return map;
  }, [filteredItems]);

  const groups = useMemo(
    () => buildMeetingGroups(filteredItems, meetingTitles),
    [filteredItems, meetingTitles]
  );

  const selectedMeeting =
    groups.find((group) => group.meetingId === selectedMeetingId) ?? groups[0] ?? null;

  const selectedActionItem =
    selectedMeeting?.items.find((item) => item.id === selectedActionItemId) ??
    selectedMeeting?.items[0] ??
    null;

  useEffect(() => {
    if (!selectedMeetingId || !groups.some((group) => group.meetingId === selectedMeetingId)) {
      setSelectedMeetingId(groups[0]?.meetingId ?? null);
    }
  }, [groups, selectedMeetingId]);

  useEffect(() => {
    if (
      !selectedActionItemId ||
      !selectedMeeting?.items.some((item) => item.id === selectedActionItemId)
    ) {
      setSelectedActionItemId(selectedMeeting?.items[0]?.id ?? null);
    }
  }, [selectedActionItemId, selectedMeeting]);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
        Action Items
      </h1>

      {isLoading && <div className="mt-6 text-[color:var(--text-secondary)]">Loading...</div>}
      {error && <div className="mt-6 text-[color:var(--danger)]">Failed to load action items.</div>}

      {!isLoading && !error && (
        <div className="mt-6 overflow-hidden rounded-[34px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-panel)]">
          <div className="grid xl:grid-cols-[280px_minmax(0,1fr)_320px]">
            <MeetingRail
              groups={groups}
              selectedMeetingId={selectedMeeting?.meetingId ?? null}
              onSelectMeeting={setSelectedMeetingId}
            />
            <MeetingActionItemsView
              meetingTitle={selectedMeeting?.title ?? "No meeting selected"}
              items={selectedMeeting?.items ?? []}
              selectedActionItemId={selectedActionItem?.id ?? null}
              onSelectActionItem={setSelectedActionItemId}
            />
            <ActionItemContextPanel
              meetingTitle={selectedMeeting?.title ?? "No meeting selected"}
              meetingSummary={selectedActionItem?.description ?? "No meeting context available."}
              actionItem={selectedActionItem}
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd web
npm test -- "src/app/(protected)/action-items/page.test.tsx" src/components/action-items/selectors.test.ts src/components/action-items/MeetingRail.test.tsx src/components/action-items/MeetingActionItemsView.test.tsx src/components/action-items/ActionItemContextPanel.test.tsx
npm run lint
```

Expected:

- page and component tests PASS
- lint PASS

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/(protected)/action-items/page.tsx" "web/src/app/(protected)/action-items/page.test.tsx" web/src/components/action-items web/src/lib/api.ts
git commit -m "feat: redesign action items page as split view"
```

## Self-Review

### Spec coverage

- Replaces the current table-only Action Items route: covered by Task 5.
- Uses a Vinyl-style meeting-context-first split view: covered by Tasks 2, 3, 4, and 5.
- Keeps the tab as one unified personal inbox across meetings visible to the signed-in user: covered by Task 1 grouping and Task 5 integration.
- Removes mockup-only chrome:
  - summary pills: omitted from all tasks
  - workspace/kanban toggle: omitted from all tasks
  - snapshot date chip: omitted from all tasks
  - browser-lab copy: omitted from all tasks

### Placeholder scan

- No `TODO`, `TBD`, or hand-wavy implementation placeholders remain.
- Each task includes file paths, example code, explicit commands, and expected results.

### Type consistency

- Production route remains `web/src/app/(protected)/action-items/page.tsx`.
- Shared view-model names are consistent: `ActionItemsPageFilters`, `MeetingActionItemsGroup`.
- The final layout remains a single production `Action Items` view, not a dual-mode concept surface.
