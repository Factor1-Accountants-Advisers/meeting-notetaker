import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionItem } from "@/types";

import MeetingActionItemsView from "./MeetingActionItemsView";

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 101,
    meeting_id: 7,
    description: "Confirm vendor shortlist and next steps",
    owner_name: "Ava",
    owner_email: "ava@example.com",
    due_date: "2026-04-03",
    status: "open",
    created_at: "2026-03-30T08:00:00.000Z",
    updated_at: "2026-03-30T08:00:00.000Z",
    ...overrides,
  };
}

describe("MeetingActionItemsView", () => {
  it("renders the meeting title, task metadata, and calls onSelectActionItem when a row is clicked", () => {
    const onSelectActionItem = vi.fn();

    render(
      <MeetingActionItemsView
        meetingTitle="Weekly design review"
        items={[makeItem()]}
        selectedActionItemId={101}
        onSelectActionItem={onSelectActionItem}
      />
    );

    expect(screen.getByText("Weekly design review")).toBeVisible();
    expect(
      screen.getByText("Confirm vendor shortlist and next steps")
    ).toBeVisible();
    expect(screen.getByText("Ava")).toBeVisible();
    expect(screen.getByText("Apr 3, 2026")).toBeVisible();

    const rowButton = screen.getByRole("option", {
      name: /confirm vendor shortlist and next steps/i,
    });

    fireEvent.click(rowButton);

    expect(onSelectActionItem).toHaveBeenCalledWith(101);
  });

  it("marks only the selected action item as selected in a multi-item list", () => {
    render(
      <MeetingActionItemsView
        meetingTitle="Weekly design review"
        items={[
          makeItem(),
          makeItem({
            id: 102,
            description: "Draft follow-up note for stakeholders",
            owner_name: "Noah",
            due_date: null,
          }),
        ]}
        selectedActionItemId={102}
        onSelectActionItem={vi.fn()}
      />
    );

    const selectedRow = screen.getByRole("option", {
      name: /draft follow-up note for stakeholders/i,
    });
    const unselectedRow = screen.getByRole("option", {
      name: /confirm vendor shortlist and next steps/i,
    });

    expect(selectedRow).toHaveAttribute("aria-selected", "true");
    expect(unselectedRow).not.toHaveAttribute("aria-selected", "true");
  });

  it("shows an empty state when there are no action items", () => {
    render(
      <MeetingActionItemsView
        meetingTitle="Weekly design review"
        items={[]}
        selectedActionItemId={null}
        onSelectActionItem={vi.fn()}
      />
    );

    expect(screen.getByText("No action items in this meeting.")).toBeVisible();
  });
});
