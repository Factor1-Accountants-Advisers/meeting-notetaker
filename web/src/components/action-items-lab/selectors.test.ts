import { describe, expect, it } from "vitest";

import { actionItemsLabMockData } from "@/components/action-items-lab/mock-data";
import {
  buildKanbanColumns,
  buildSummary,
  buildWorkspaceBuckets,
  filterTasks,
} from "@/components/action-items-lab/selectors";
import type { ActionItemsLabFilters } from "@/components/action-items-lab/types";

const today = new Date("2026-03-31T00:00:00.000Z");

describe("action items lab selectors", () => {
  it("builds summary counts from the shared mock data", () => {
    expect(buildSummary(actionItemsLabMockData, today)).toEqual({
      open: 8,
      dueThisWeek: 5,
      overdue: 2,
      completed: 3,
    });
  });

  it("filters by search, owner, status, and due date together", () => {
    const filters: ActionItemsLabFilters = {
      search: "board deck",
      owner: "Nina",
      status: "open",
      due: "week",
    };

    const filtered = filterTasks(actionItemsLabMockData, filters, today);

    expect(filtered.map((task) => task.id)).toEqual(["task-05"]);
  });

  it("groups workspace buckets by due date", () => {
    const buckets = buildWorkspaceBuckets(actionItemsLabMockData, today);
    const byId = Object.fromEntries(buckets.map((bucket) => [bucket.id, bucket]));

    expect(byId.overdue?.items).toHaveLength(2);
    expect(byId.today?.items).toHaveLength(1);
    expect(byId["no-due-date"]?.items).toHaveLength(2);
  });

  it("builds kanban columns in the expected order", () => {
    const columns = buildKanbanColumns(actionItemsLabMockData, today);

    expect(columns.map((column) => column.id)).toEqual([
      "needs-attention",
      "this-week",
      "planned",
      "done",
    ]);
    expect(columns.find((column) => column.id === "done")?.items.every((task) => task.status === "complete")).toBe(true);
  });
});
