import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionItem, ActionItemListResponse, MeetingDetail, MeetingListResponse } from "@/types";

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function makeActionItemsResponse(overrides: Partial<ActionItemListResponse> = {}): ActionItemListResponse {
  return {
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
    ...overrides,
  };
}

function makeMeetingsResponse(overrides: Partial<MeetingListResponse> = {}): MeetingListResponse {
  return {
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
    ...overrides,
  };
}

function makeMeetingDetail(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
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
    ...overrides,
  };
}

function renderPage(options: {
  actionItemsData?: ActionItemListResponse | undefined;
  actionItemsError?: Error | undefined;
  actionItemsLoading?: boolean;
  meetingsData?: MeetingListResponse | undefined;
  meetingsError?: Error | undefined;
  meetingsLoading?: boolean;
  meetingData?: MeetingDetail | undefined;
} = {}) {
  const actionItemsData =
    "actionItemsData" in options ? options.actionItemsData : makeActionItemsResponse();
  const actionItemsError = options.actionItemsError;
  const actionItemsLoading = options.actionItemsLoading ?? false;
  const meetingsData = "meetingsData" in options ? options.meetingsData : makeMeetingsResponse();
  const meetingsError = options.meetingsError;
  const meetingsLoading = options.meetingsLoading ?? false;
  const meetingData = "meetingData" in options ? options.meetingData : makeMeetingDetail();

  mockedUseActionItems.mockReturnValue({
    data: actionItemsData,
    error: actionItemsError,
    isLoading: actionItemsLoading,
  } as never);

  mockedUseMeetings.mockReturnValue({
    data: meetingsData,
    error: meetingsError,
    isLoading: meetingsLoading,
  } as never);

  mockedUseMeeting.mockReturnValue({
    data: meetingData,
    error: undefined,
    isLoading: false,
  } as never);

  render(<ActionItemsPage />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ActionItemsPage", () => {
  it("renders the production split view and loads meeting context for the default selected meeting", () => {
    renderPage();

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
    expect(mockedUseActionItems).toHaveBeenCalledWith(1, 250);
    expect(mockedUseMeetings).toHaveBeenCalledWith(1, 500);
    expect(mockedUseMeeting).toHaveBeenCalledWith(7);
  });

  it("shows loading as a status update", () => {
    renderPage({
      actionItemsData: undefined,
      actionItemsLoading: true,
    });

    expect(screen.getByRole("status")).toHaveTextContent("Loading action items...");
  });

  it("shows errors as alerts", () => {
    renderPage({
      actionItemsError: new Error("boom"),
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load action items.");
  });

  it("shows the empty state as a status update and skips selected meeting context", () => {
    renderPage({
      actionItemsData: makeActionItemsResponse({ items: [], total: 0 }),
      meetingsData: makeMeetingsResponse({ items: [], total: 0 }),
      meetingData: undefined,
    });

    expect(screen.getByRole("status")).toHaveTextContent("No action items yet.");
    expect(mockedUseMeeting).toHaveBeenCalledWith(undefined);
  });

  it("shows a truncation notice when the API reports more action items than were loaded", () => {
    const extraItems: ActionItem[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      meeting_id: 7,
      description: `Action item ${index + 1}`,
      owner_name: "Ava",
      owner_email: "ava@example.com",
      due_date: null,
      status: "open",
      created_at: "2026-03-30T08:00:00.000Z",
      updated_at: "2026-03-30T08:00:00.000Z",
    }));

    renderPage({
      actionItemsData: makeActionItemsResponse({
        items: extraItems,
        total: 150,
        per_page: 100,
      }),
      meetingsData: makeMeetingsResponse({
        items: [makeMeetingsResponse().items[0]],
        total: 1,
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the first 100 of 150 action items."
    );
  });

  it("shows a title-resolution notice when visible meeting groups are missing titles from the meetings payload", () => {
    renderPage({
      actionItemsData: makeActionItemsResponse({
        items: [
          {
            id: 201,
            meeting_id: 999,
            description: "Follow up on budget changes",
            owner_name: "Ava",
            owner_email: "ava@example.com",
            due_date: null,
            status: "open",
            created_at: "2026-03-30T08:00:00.000Z",
            updated_at: "2026-03-30T08:00:00.000Z",
          },
        ],
        total: 1,
      }),
      meetingsData: makeMeetingsResponse({
        items: [],
        total: 500,
        per_page: 250,
      }),
      meetingData: makeMeetingDetail({
        id: 999,
        title: "Meeting 999",
      }),
    });

    expect(screen.getByRole("button", { name: /meeting 999/i })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Some visible meetings are using fallback titles because meeting details were not loaded."
    );
  });

  it("suppresses the fallback warning while meetings metadata is still loading and shows a loading note instead", () => {
    renderPage({
      actionItemsData: makeActionItemsResponse({
        items: [
          {
            id: 301,
            meeting_id: 999,
            description: "Confirm budget owner",
            owner_name: "Ava",
            owner_email: "ava@example.com",
            due_date: null,
            status: "open",
            created_at: "2026-03-30T08:00:00.000Z",
            updated_at: "2026-03-30T08:00:00.000Z",
          },
        ],
        total: 1,
      }),
      meetingsData: undefined,
      meetingsLoading: true,
      meetingData: makeMeetingDetail({
        id: 999,
        title: "Meeting 999",
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("Loading meeting titles...");
    expect(
      screen.queryByText(
        "Some visible meetings are using fallback titles because meeting details were not loaded."
      )
    ).not.toBeInTheDocument();
  });

  it("replaces the fallback warning with an error notice when meetings metadata fails", () => {
    renderPage({
      actionItemsData: makeActionItemsResponse({
        items: [
          {
            id: 401,
            meeting_id: 999,
            description: "Confirm budget owner",
            owner_name: "Ava",
            owner_email: "ava@example.com",
            due_date: null,
            status: "open",
            created_at: "2026-03-30T08:00:00.000Z",
            updated_at: "2026-03-30T08:00:00.000Z",
          },
        ],
        total: 1,
      }),
      meetingsData: undefined,
      meetingsError: new Error("metadata failed"),
      meetingData: makeMeetingDetail({
        id: 999,
        title: "Meeting 999",
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Meeting titles could not be loaded."
    );
    expect(
      screen.queryByText(
        "Some visible meetings are using fallback titles because meeting details were not loaded."
      )
    ).not.toBeInTheDocument();
  });
});
