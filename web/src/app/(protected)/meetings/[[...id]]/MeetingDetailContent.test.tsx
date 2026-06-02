import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MeetingDetail } from "@/types";

import MeetingDetailContent from "./MeetingDetailContent";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: ["7"] }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  useMeeting: vi.fn(),
  updateSpeakerMappings: vi.fn(),
  resolveActionOwners: vi.fn(),
}));

import { updateSpeakerMappings, useMeeting } from "@/lib/api";

const mockedUseMeeting = vi.mocked(useMeeting);
const mockedUpdateSpeakerMappings = vi.mocked(updateSpeakerMappings);

function makeMeetingDetail(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: 7,
    title: "Weekly design review",
    scheduled_time: null,
    duration_seconds: null,
    status: "complete",
    audio_url: null,
    created_at: "2026-03-30T08:00:00.000Z",
    participants: [
      { id: 1, name: "Ava", email: "ava@example.com" },
      { id: 2, name: "Noah", email: "noah@example.com" },
    ],
    transcript: {
      meeting_id: 7,
      segments: [
        {
          speaker: "Speaker A",
          raw_speaker: "A",
          matched_email: null,
          match_confidence: 0.52,
          start: 0,
          end: 4,
          text: "We need to confirm the vendor shortlist by Friday.",
        },
        {
          speaker: "Speaker B",
          raw_speaker: "B",
          matched_email: null,
          match_confidence: 0.43,
          start: 5,
          end: 9,
          text: "I can prepare the rollout timeline after that.",
        },
      ],
    },
    summary: {
      summary_text: "Reviewed vendor and rollout next steps.",
      key_points: [],
      follow_ups: [],
    },
    action_items: [],
    needs_speaker_review: false,
    speaker_review_completed_at: null,
    speaker_mapping_quality: null,
    diarization_diagnostics: null,
    speaker_mappings: [
      {
        id: 101,
        meeting_id: 7,
        speaker_label: "A",
        display_name: null,
        email: null,
        confidence: 0.52,
        source: "llm_inference",
        reason: "Low confidence",
        created_at: "2026-03-30T08:00:00.000Z",
        updated_at: "2026-03-30T08:00:00.000Z",
      },
      {
        id: 102,
        meeting_id: 7,
        speaker_label: "B",
        display_name: null,
        email: null,
        confidence: 0.43,
        source: "llm_inference",
        reason: "Low confidence",
        created_at: "2026-03-30T08:00:00.000Z",
        updated_at: "2026-03-30T08:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderDetail(meeting: MeetingDetail) {
  const mutate = vi.fn();
  mockedUseMeeting.mockReturnValue({
    data: meeting,
    error: undefined,
    isLoading: false,
    mutate,
  } as never);

  render(<MeetingDetailContent />);

  return { mutate };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("MeetingDetailContent speaker review", () => {
  it("shows the speaker review panel without the old verbose review banner", () => {
    renderDetail(makeMeetingDetail({ needs_speaker_review: true }));

    expect(screen.queryByText(/Some speaker labels are uncertain/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Speaker review" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Confirm who spoke" })).toBeVisible();
  });

  it("shows concise diarization diagnostics when available", () => {
    renderDetail(makeMeetingDetail({
      diarization_diagnostics: {
        detected_speaker_count: 2,
        mapped_speaker_count: 1,
        average_mapping_confidence: 0.78,
      },
    }));

    expect(screen.getByRole("heading", { name: "Diarization quality" })).toBeVisible();
    expect(screen.getByText("Detected speakers")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText("Mapped speakers")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.getByText("Average confidence")).toBeVisible();
    expect(screen.getByText("78%")).toBeVisible();
  });

  it("saves speaker mappings and revalidates the meeting detail", async () => {
    mockedUpdateSpeakerMappings.mockResolvedValue({
      items: [],
      needs_speaker_review: false,
      speaker_mapping_quality: 1,
    });
    const { mutate } = renderDetail(makeMeetingDetail({ needs_speaker_review: true }));

    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }));

    await waitFor(() => {
      expect(mockedUpdateSpeakerMappings).toHaveBeenCalledWith(
        7,
        expect.arrayContaining([
          expect.objectContaining({
            speaker_label: "A",
            display_name: null,
            email: null,
            source: "user_corrected",
          }),
          expect.objectContaining({
            speaker_label: "B",
            display_name: null,
            email: null,
            source: "user_corrected",
          }),
        ])
      );
    });
    expect(mutate).toHaveBeenCalledWith();
  });
});
