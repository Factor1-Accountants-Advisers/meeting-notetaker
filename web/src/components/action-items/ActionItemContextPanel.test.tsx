import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ActionItemContextPanel from "./ActionItemContextPanel";

describe("ActionItemContextPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const meetingTitle = "Weekly design review";
  const meetingSummary =
    "Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo.";
  const actionItem = {
    id: 101,
    description: "Confirm vendor shortlist and next steps",
    owner_name: "Ava",
    due_date: "2026-04-03",
    status: "open",
  } as const;

  function renderPanel(
    overrides: Partial<React.ComponentProps<typeof ActionItemContextPanel>> = {}
  ) {
    const onSave = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);

    render(
      <ActionItemContextPanel
        meetingTitle={meetingTitle}
        meetingSummary={meetingSummary}
        actionItem={actionItem}
        onSave={onSave}
        onDelete={onDelete}
        {...overrides}
      />
    );

    return { onSave, onDelete };
  }

  it("renders editable task fields and disabled pristine actions", () => {
    renderPanel();

    expect(
      screen.getByRole("complementary", { name: "Action item context" })
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Task details" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Source meeting" })).toBeVisible();

    expect(screen.getByPlaceholderText("Describe the action item...")).toHaveValue(
      actionItem.description
    );
    expect(screen.getByPlaceholderText("Unassigned")).toHaveValue(actionItem.owner_name);
    expect(screen.getByDisplayValue(actionItem.due_date)).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveValue(actionItem.status);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete action item" })).not.toBeDisabled();
    expect(screen.getByText(meetingTitle)).toBeVisible();
    expect(screen.getByText(meetingSummary)).toBeVisible();
  });

  it("shows owner uncertainty when extracted ownership confidence is low", () => {
    renderPanel({
      actionItem: {
        ...actionItem,
        owner_confidence: 0.52,
        owner_source: "llm_extraction",
      },
    });

    expect(screen.getByText("Owner uncertain")).toBeVisible();
    expect(screen.queryByText("Owner confirmed")).not.toBeInTheDocument();
  });

  it("shows owner uncertainty when no owner is assigned", () => {
    renderPanel({
      actionItem: {
        ...actionItem,
        owner_name: null,
        owner_confidence: null,
        owner_source: "unassigned",
      },
    });

    expect(screen.getByPlaceholderText("Unassigned")).toHaveValue("");
    expect(screen.getByText("Owner uncertain")).toBeVisible();
  });

  it("shows confirmed ownership without uncertainty when the owner was user-corrected", () => {
    renderPanel({
      actionItem: {
        ...actionItem,
        owner_confidence: 1,
        owner_source: "user_corrected",
      },
    });

    expect(screen.getByText("Owner confirmed")).toBeVisible();
    expect(screen.queryByText("Owner uncertain")).not.toBeInTheDocument();
  });

  it("shows likely ownership for high-confidence inferred owners", () => {
    renderPanel({
      actionItem: {
        ...actionItem,
        owner_confidence: 0.86,
        owner_source: "explicit_name_match",
      },
    });

    expect(screen.getByText("Owner likely")).toBeVisible();
  });

  it("emits partial patches when task fields change", async () => {
    const { onSave } = renderPanel();

    fireEvent.change(screen.getByPlaceholderText("Describe the action item..."), {
      target: { value: "Update the vendor shortlist" },
    });
    fireEvent.change(screen.getByPlaceholderText("Unassigned"), {
      target: { value: "Mia" },
    });
    fireEvent.change(screen.getByDisplayValue(actionItem.due_date), {
      target: { value: "2026-04-10" },
    });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "complete" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(101, {
        description: "Update the vendor shortlist",
        owner_name: "Mia",
        due_date: "2026-04-10",
        status: "complete",
      });
    });
  });

  it("disables save, reset, and delete while saving", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete action item" })).not.toBeDisabled();
  });

  it("renders the editor safely when no action item is selected", () => {
    render(
      <ActionItemContextPanel
        meetingTitle={meetingTitle}
        meetingSummary={meetingSummary}
        actionItem={null}
        onSave={async () => undefined}
        onDelete={async () => undefined}
      />
    );

    expect(screen.getByText("Select an action item to view and edit its details.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete action item" })).not.toBeInTheDocument();
  });
});
