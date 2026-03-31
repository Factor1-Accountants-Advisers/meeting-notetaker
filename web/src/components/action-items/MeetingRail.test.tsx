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
  it("shows an empty state when there are no meetings", () => {
    render(
      <MeetingRail
        groups={[]}
        selectedMeetingId={null}
        onSelectMeeting={vi.fn()}
      />
    );

    expect(screen.getByText("No meetings available.")).toBeVisible();
  });

  it("shows the meeting title, marks the selected meeting current, and calls onSelectMeeting when clicked", () => {
    const onSelectMeeting = vi.fn();

    render(
      <MeetingRail
        groups={[
          makeGroup({
            meetingId: 7,
            title: "Weekly design review",
            openCount: 2,
            completedCount: 0,
          }),
        ]}
        selectedMeetingId={7}
        onSelectMeeting={onSelectMeeting}
      />
    );

    const meetingButton = screen.getByRole("button", {
      name: /weekly design review/i,
    });

    expect(screen.getByText("Weekly design review")).toBeVisible();
    expect(meetingButton).toHaveAttribute("aria-current", "true");
    expect(meetingButton).not.toHaveAttribute("aria-pressed");

    fireEvent.click(meetingButton);

    expect(onSelectMeeting).toHaveBeenCalledWith(7);
  });
});
