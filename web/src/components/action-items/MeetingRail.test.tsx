import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MeetingActionItemsGroup } from "@/components/action-items/types";

import MeetingRail from "./MeetingRail";

function makeGroup(overrides: Partial<MeetingActionItemsGroup>): MeetingActionItemsGroup {
  return {
    meetingId: 42,
    title: "Quarterly planning sync",
    items: [],
    openCount: 2,
    completedCount: 0,
    owners: ["Ava"],
    ...overrides,
  };
}

describe("MeetingRail", () => {
  it("shows the meeting title and calls onSelectMeeting when clicked", async () => {
    const onSelectMeeting = vi.fn();

    render(
      <MeetingRail
        groups={[makeGroup({ meetingId: 7, title: "Weekly design review", openCount: 2, completedCount: 0 })]}
        selectedMeetingId={null}
        onSelectMeeting={onSelectMeeting}
      />
    );

    expect(screen.getByText("Weekly design review")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /weekly design review/i }));

    expect(onSelectMeeting).toHaveBeenCalledWith(7);
  });
});
