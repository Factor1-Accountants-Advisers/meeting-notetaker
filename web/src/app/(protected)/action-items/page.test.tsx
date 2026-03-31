import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ActionItemsPage from "./page";

vi.mock("@/lib/api", () => ({
  useActionItems: vi.fn(),
  useMeetings: vi.fn(),
  useMeeting: vi.fn(),
}));

import { useActionItems, useMeeting, useMeetings } from "@/lib/api";

const mockedUseActionItems = vi.mocked(useActionItems);
const mockedUseMeetings = vi.mocked(useMeetings);
const mockedUseMeeting = vi.mocked(useMeeting);

describe("ActionItemsPage", () => {
  it("renders the production split view with meeting context from the API hooks", () => {
    mockedUseActionItems.mockReturnValue({
      data: {
        items: [
          {
            id: 101,
            meeting_id: 7,
            description: "Confirm vendor shortlist and next steps",
            owner_name: "Ava",
            owner_email: "ava@example.com",
            due_date: "2026-04-03",
            status: "open",
            created_at: "2026-03-30T08:00:00.000Z",
            updated_at: "2026-03-30T08:00:00.000Z",
          },
          {
            id: 102,
            meeting_id: 8,
            description: "Send revised rollout timeline",
            owner_name: "Noah",
            owner_email: "noah@example.com",
            due_date: null,
            status: "complete",
            created_at: "2026-03-30T09:00:00.000Z",
            updated_at: "2026-03-30T09:00:00.000Z",
          },
        ],
        total: 2,
        page: 1,
        per_page: 100,
        has_next: false,
      },
      error: undefined,
      isLoading: false,
    } as never);

    mockedUseMeetings.mockReturnValue({
      data: {
        items: [
          {
            id: 7,
            title: "Weekly design review",
            scheduled_time: null,
            duration_seconds: null,
            status: "processed",
            participant_count: 4,
            has_summary: true,
            created_at: "2026-03-30T08:00:00.000Z",
          },
          {
            id: 8,
            title: "Launch readiness sync",
            scheduled_time: null,
            duration_seconds: null,
            status: "processed",
            participant_count: 5,
            has_summary: true,
            created_at: "2026-03-30T09:00:00.000Z",
          },
        ],
        total: 2,
        page: 1,
        per_page: 100,
        has_next: false,
      },
      error: undefined,
      isLoading: false,
    } as never);

    mockedUseMeeting.mockReturnValue({
      data: {
        id: 7,
        title: "Weekly design review",
        scheduled_time: null,
        duration_seconds: null,
        status: "processed",
        audio_url: null,
        created_at: "2026-03-30T08:00:00.000Z",
        participants: [],
        transcript: null,
        summary: {
          summary_text:
            "Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo.",
          key_points: [],
          follow_ups: [],
        },
        action_items: [],
      },
      error: undefined,
      isLoading: false,
    } as never);

    render(<ActionItemsPage />);

    expect(
      screen.getByRole("heading", { name: "Action Items" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /weekly design review/i })
    ).toBeVisible();
    expect(
      screen.getAllByText("Confirm vendor shortlist and next steps")[0]
    ).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "Action item context" })
    ).toBeVisible();
    expect(
      screen.getByText(
        "Reviewed the onboarding flow, resolved copy changes, and confirmed the next demo."
      )
    ).toBeVisible();
  });
});
