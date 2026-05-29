import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SpeakerReviewPanel from "./SpeakerReviewPanel";
import type { Participant, SpeakerMapping, TranscriptSegment } from "@/types";

const participants: Participant[] = [
  { id: 1, name: "Alex Rivera", email: "alex@example.com" },
  { id: 2, name: "Jordan Kim", email: "jordan@example.com" },
];

const segments: TranscriptSegment[] = [
  {
    speaker: "Alex Rivera",
    raw_speaker: "SPEAKER_00",
    start: 0,
    end: 4,
    text: "We should launch the pilot with the existing customer group next week.",
  },
  {
    speaker: "Jordan Kim",
    raw_speaker: "SPEAKER_01",
    start: 5,
    end: 8,
    text: "I can prepare the rollout dashboard before Friday.",
  },
  {
    speaker: "Alex Rivera",
    raw_speaker: "SPEAKER_00",
    start: 9,
    end: 12,
    text: "Short follow up.",
  },
];

const mappings: SpeakerMapping[] = [
  {
    id: 10,
    meeting_id: 99,
    speaker_label: "SPEAKER_00",
    display_name: "Alex Rivera",
    email: "alex@example.com",
    confidence: 0.87,
    source: "llm_inference",
    reason: "Matched by self-introduction",
    created_at: "2026-05-29T00:00:00.000Z",
    updated_at: "2026-05-29T00:00:00.000Z",
  },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof SpeakerReviewPanel>> = {}) {
  const onSave = vi.fn(async () => undefined);
  const props = {
    segments,
    mappings,
    participants,
    onSave,
    ...overrides,
  } satisfies React.ComponentProps<typeof SpeakerReviewPanel>;

  const result = render(<SpeakerReviewPanel {...props} />);

  return { onSave, rerender: result.rerender, props };
}

describe("SpeakerReviewPanel", () => {
  it("renders one card per speaker label", () => {
    renderPanel();

    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "SPEAKER_00" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "SPEAKER_01" })).toBeVisible();
  });

  it("shows representative quotes", () => {
    renderPanel();

    expect(
      screen.getByText("We should launch the pilot with the existing customer group next week.")
    ).toBeVisible();
    expect(screen.getByText("Short follow up.")).toBeVisible();
    expect(screen.getByText("I can prepare the rollout dashboard before Friday.")).toBeVisible();
  });

  it("shows current mapping, confidence, and source", () => {
    renderPanel();
    const card = screen.getByRole("article", { name: /SPEAKER_00/i });

    expect(within(card).getByText("Alex Rivera")).toBeVisible();
    expect(within(card).getByText("alex@example.com")).toBeVisible();
    expect(within(card).getByText("87% confidence")).toBeVisible();
    expect(within(card).getByText("llm inference")).toBeVisible();
  });

  it("dropdown contains participants and current candidates", () => {
    renderPanel();

    const speakerSelect = screen.getByLabelText("Mapping for SPEAKER_00");
    expect(within(speakerSelect).getByRole("option", { name: "Unknown" })).toBeInTheDocument();
    expect(
      within(speakerSelect).getByRole("option", { name: "Alex Rivera (alex@example.com)" })
    ).toBeInTheDocument();
    expect(
      within(speakerSelect).getByRole("option", { name: "Jordan Kim (jordan@example.com)" })
    ).toBeInTheDocument();
    expect(within(speakerSelect).getByRole("option", { name: "Custom name" })).toBeInTheDocument();
    expect(speakerSelect).toHaveValue("participant:alex@example.com");
  });

  it("save calls onSave with mapping updates", async () => {
    const { onSave } = renderPanel();

    fireEvent.change(screen.getByLabelText("Mapping for SPEAKER_01"), {
      target: { value: "participant:jordan@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith([
        {
          speaker_label: "SPEAKER_00",
          display_name: "Alex Rivera",
          email: "alex@example.com",
          confidence: 1,
          source: "user_corrected",
          reason: "Confirmed in speaker review panel",
        },
        {
          speaker_label: "SPEAKER_01",
          display_name: "Jordan Kim",
          email: "jordan@example.com",
          confidence: 1,
          source: "user_corrected",
          reason: "Confirmed in speaker review panel",
        },
      ]);
    });
  });

  it("allows Unknown mapping", async () => {
    const { onSave } = renderPanel();

    fireEvent.change(screen.getByLabelText("Mapping for SPEAKER_00"), {
      target: { value: "unknown" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.arrayContaining([
          {
            speaker_label: "SPEAKER_00",
            display_name: null,
            email: null,
            confidence: 1,
            source: "user_corrected",
            reason: "Marked unknown in speaker review panel",
          },
        ])
      );
    });
  });

  it("saves a custom display name without an email", async () => {
    const { onSave } = renderPanel();

    fireEvent.change(screen.getByLabelText("Mapping for SPEAKER_01"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Custom display name"), {
      target: { value: "Morgan Lee" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.arrayContaining([
          {
            speaker_label: "SPEAKER_01",
            display_name: "Morgan Lee",
            email: null,
            confidence: 1,
            source: "user_corrected",
            reason: "Entered custom display name in speaker review panel",
          },
        ])
      );
    });
  });

  it("shows one Custom name option when the current mapping is a non-participant custom name", () => {
    renderPanel({
      mappings: [
        ...mappings,
        {
          id: 11,
          meeting_id: 99,
          speaker_label: "SPEAKER_01",
          display_name: "Outside Consultant",
          email: null,
          confidence: 0.71,
          source: "user_corrected",
          reason: "Provided by organizer",
          created_at: "2026-05-29T00:00:00.000Z",
          updated_at: "2026-05-29T00:00:00.000Z",
        },
      ],
    });

    const card = screen.getByRole("article", { name: /SPEAKER_01/i });
    const speakerSelect = within(card).getByLabelText("Mapping for SPEAKER_01");

    expect(within(card).getByText("Outside Consultant")).toBeVisible();
    expect(within(speakerSelect).getAllByRole("option", { name: "Custom name" })).toHaveLength(1);
    expect(within(speakerSelect).queryByRole("option", { name: "Outside Consultant" })).not.toBeInTheDocument();
    expect(speakerSelect).toHaveValue("custom");
  });

  it("preserves dirty user edits when refreshed with new mapping props for the same speakers", () => {
    const { props, rerender } = renderPanel();

    fireEvent.change(screen.getByLabelText("Mapping for SPEAKER_01"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Custom display name"), {
      target: { value: "Morgan Lee" },
    });

    rerender(
      <SpeakerReviewPanel
        {...props}
        mappings={[
          ...mappings,
          {
            id: 11,
            meeting_id: 99,
            speaker_label: "SPEAKER_01",
            display_name: "Jordan Kim",
            email: "jordan@example.com",
            confidence: 0.92,
            source: "llm_inference",
            reason: "Late-arriving inference result",
            created_at: "2026-05-29T00:00:00.000Z",
            updated_at: "2026-05-29T00:00:00.000Z",
          },
        ]}
      />
    );

    expect(screen.getByLabelText("Mapping for SPEAKER_01")).toHaveValue("custom");
    expect(screen.getByLabelText("Custom display name")).toHaveValue("Morgan Lee");
  });
});
