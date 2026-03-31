import { describe, expect, it } from "vitest";

import type { ActionItem } from "@/types";
import { buildMeetingGroups, filterActionItems } from "@/components/action-items/selectors";

function makeActionItem(overrides: Partial<ActionItem>): ActionItem {
  return {
    id: 1,
    meeting_id: 100,
    description: "Review checklist with the team",
    owner_name: "nina",
    owner_email: "nina@example.com",
    due_date: null,
    status: "open",
    created_at: "2026-03-30T00:00:00.000Z",
    updated_at: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterActionItems", () => {
  it("filters by owner, status, and search text", () => {
    const items = [
      makeActionItem({ id: 1, meeting_id: 100, owner_name: "nina", status: "open", description: "Review checklist with the team" }),
      makeActionItem({ id: 2, meeting_id: 101, owner_name: "nina", status: "complete", description: "Finalize checklist" }),
      makeActionItem({ id: 3, meeting_id: 101, owner_name: "lee", status: "open", description: "Checklist follow-up" }),
    ];

    const filtered = filterActionItems(items, {
      owner: "nina",
      status: "open",
      search: "checklist",
    });

    expect(filtered.map((item) => item.id)).toEqual([1]);
  });
});

describe("buildMeetingGroups", () => {
  it("groups items by source meeting", () => {
    const items = [
      makeActionItem({ id: 4, meeting_id: 101, owner_name: "maria", status: "open", description: "Alpha planning review" }),
      makeActionItem({ id: 5, meeting_id: 101, owner_name: "maria", status: "complete", description: "Alpha planning review" }),
      makeActionItem({ id: 6, meeting_id: 101, owner_name: "sam", status: "open", description: "Alpha planning review" }),
      makeActionItem({ id: 1, meeting_id: 100, owner_name: "nina", status: "open", description: "Zeta operations sync" }),
      makeActionItem({ id: 2, meeting_id: 100, owner_name: "lee", status: "complete", description: "Zeta operations sync" }),
      makeActionItem({ id: 3, meeting_id: 100, owner_name: "nina", status: "open", description: "Zeta operations sync" }),
    ];

    const groups = buildMeetingGroups(items, {
      100: "Zeta operations sync",
      101: "Alpha planning review",
    });

    expect(groups.map((group) => group.meetingId)).toEqual([101, 100]);
    expect(groups[0]).toMatchObject({
      meetingId: 101,
      title: "Alpha planning review",
      openCount: 2,
      completedCount: 1,
      owners: ["maria", "sam"],
    });
    expect(groups[1]).toMatchObject({
      meetingId: 100,
      title: "Zeta operations sync",
      openCount: 2,
      completedCount: 1,
      owners: ["nina", "lee"],
    });
  });
});
