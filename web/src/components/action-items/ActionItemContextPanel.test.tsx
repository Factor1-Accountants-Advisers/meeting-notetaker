import { fireEvent, render, screen } from "@testing-library/react";
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
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const onReset = vi.fn();
    const onDelete = vi.fn();

    render(
      <ActionItemContextPanel
        meetingTitle={meetingTitle}
        meetingSummary={meetingSummary}
        actionItem={actionItem}
        draft={{
          description: actionItem.description,
          owner_name: actionItem.owner_name,
          due_date: actionItem.due_date,
          status: actionItem.status,
        }}
        isDirty={false}
        isSaving={false}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onReset={onReset}
        onDelete={onDelete}
        {...overrides}
      />
    );

    return { onDraftChange, onSave, onReset, onDelete };
  }

  it("renders editable task fields and disabled pristine actions", () => {
    renderPanel();

    expect(
      screen.getByRole("complementary", { name: "Action item context" })
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Task details" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Meeting context" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Actions" })).toBeVisible();

    expect(screen.getByLabelText("Task description")).toHaveValue(
      actionItem.description
    );
    expect(screen.getByLabelText("Owner")).toHaveValue(actionItem.owner_name);
    expect(screen.getByLabelText("Due date")).toHaveValue(actionItem.due_date);
    expect(screen.getByLabelText("Status")).toHaveValue(actionItem.status);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete task" })).not.toBeDisabled();
    expect(screen.getByText(meetingTitle)).toBeVisible();
    expect(screen.getByText(meetingSummary)).toBeVisible();
  });

  it("emits partial patches when task fields change", () => {
    const { onDraftChange } = renderPanel();

    fireEvent.change(screen.getByLabelText("Task description"), {
      target: { value: "Update the vendor shortlist" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "Mia" },
    });
    fireEvent.change(screen.getByLabelText("Due date"), {
      target: { value: "2026-04-10" },
    });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "complete" },
    });

    expect(onDraftChange).toHaveBeenNthCalledWith(1, {
      description: "Update the vendor shortlist",
    });
    expect(onDraftChange).toHaveBeenNthCalledWith(2, {
      owner_name: "Mia",
    });
    expect(onDraftChange).toHaveBeenNthCalledWith(3, {
      due_date: "2026-04-10",
    });
    expect(onDraftChange).toHaveBeenNthCalledWith(4, {
      status: "complete",
    });
  });

  it("disables save, reset, and delete while saving", () => {
    renderPanel({
      isDirty: true,
      isSaving: true,
    });

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete task" })).toBeDisabled();
  });

  it("renders the editor safely when no action item is selected", () => {
    render(
      <ActionItemContextPanel
        meetingTitle={meetingTitle}
        meetingSummary={meetingSummary}
        actionItem={null}
        draft={{
          description: actionItem.description,
          owner_name: actionItem.owner_name,
          due_date: actionItem.due_date,
          status: actionItem.status,
        }}
        isDirty={false}
        isSaving={false}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
        onReset={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Task description")).toBeVisible();
    expect(screen.getByLabelText("Owner")).toBeVisible();
    expect(screen.getByLabelText("Due date")).toBeVisible();
    expect(screen.getByLabelText("Status")).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete task" })).toBeDisabled();
  });
});
