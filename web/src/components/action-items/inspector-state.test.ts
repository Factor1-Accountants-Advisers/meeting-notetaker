import { describe, expect, it } from "vitest";

import type { ActionItem } from "@/types";
import {
  createActionItemDraft,
  isActionItemDraftDirty,
} from "@/components/action-items/inspector-state";

function makeActionItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 42,
    meeting_id: 1001,
    description: "Finalize owner list for the launch review",
    owner_name: "nina",
    owner_email: "nina@example.com",
    due_date: "2026-04-15",
    status: "open",
    created_at: "2026-04-01T08:00:00.000Z",
    updated_at: "2026-04-02T09:30:00.000Z",
    ...overrides,
  };
}

describe("createActionItemDraft", () => {
  it("returns editable string values from an action item", () => {
    const item = makeActionItem();

    expect(createActionItemDraft(item)).toEqual({
      description: "Finalize owner list for the launch review",
      owner_name: "nina",
      owner_email: "nina@example.com",
      due_date: "2026-04-15",
      status: "open",
    });
  });

  it("returns empty strings and open status for a null item", () => {
    expect(createActionItemDraft(null)).toEqual({
      description: "",
      owner_name: "",
      owner_email: "",
      due_date: "",
      status: "open",
    });
  });
});

describe("isActionItemDraftDirty", () => {
  it("returns false when the draft matches the item", () => {
    const item = makeActionItem();
    const draft = createActionItemDraft(item);

    expect(isActionItemDraftDirty(item, draft)).toBe(false);
  });

  it("returns true when a draft field changes", () => {
    const item = makeActionItem();
    const draft = createActionItemDraft(item);

    expect(
      isActionItemDraftDirty(item, {
        ...draft,
        owner_name: "lee",
      })
    ).toBe(true);
  });
});
