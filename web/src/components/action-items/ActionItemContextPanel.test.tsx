import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ActionItemContextPanel from "./ActionItemContextPanel";

describe("ActionItemContextPanel", () => {
  it("renders the source meeting and selected action item details", () => {
    render(
      <ActionItemContextPanel
        meetingTitle="Weekly design review"
        meetingSummary="Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo."
        actionItem={{
          id: 101,
          description: "Confirm vendor shortlist and next steps",
          owner_name: "Ava",
          due_date: "2026-04-03",
          status: "open",
        }}
      />
    );

    expect(screen.getByText("Source meeting")).toBeVisible();
    expect(screen.getByText("Weekly design review")).toBeVisible();
    expect(
      screen.getByText(
        "Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo."
      )
    ).toBeVisible();
    expect(screen.getByText("Selected action item")).toBeVisible();
    expect(
      screen.getByText("Confirm vendor shortlist and next steps")
    ).toBeVisible();
    expect(screen.getByText("Ava")).toBeVisible();
    expect(screen.getByText("Apr 3, 2026")).toBeVisible();
    expect(screen.getByText("Open")).toBeVisible();
  });

  it("keeps the meeting context visible when no action item is selected", () => {
    render(
      <ActionItemContextPanel
        meetingTitle="Weekly design review"
        meetingSummary="Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo."
        actionItem={null}
      />
    );

    expect(screen.getByText("Weekly design review")).toBeVisible();
    expect(
      screen.getByText(
        "Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo."
      )
    ).toBeVisible();
    expect(screen.getByText("No action item selected.")).toBeVisible();
  });
});
