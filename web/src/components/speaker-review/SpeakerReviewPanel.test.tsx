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

function chooseMapping(label: string, optionName: string | RegExp) {
  const speakerIndex = label.endsWith("00") ? 1 : 2;
  fireEvent.click(screen.getByLabelText(`Who said Speaker ${speakerIndex}`));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

describe("SpeakerReviewPanel", () => {
  it("renders one card per speaker label", () => {
    renderPanel();

    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Speaker 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Speaker 2" })).toBeVisible();
    expect(screen.getByText("Detected label: SPEAKER_00")).toBeVisible();
    expect(screen.getByText("Detected label: SPEAKER_01")).toBeVisible();
  });

  it("shows representative quotes with timestamps", () => {
    renderPanel();

    expect(screen.getByText("0:00")).toBeVisible();
    expect(screen.getByText("0:05")).toBeVisible();
    expect(
      screen.getByText("We should launch the pilot with the existing customer group next week.")
    ).toBeVisible();
    expect(screen.getByText("Short follow up.")).toBeVisible();
    expect(screen.getByText("I can prepare the rollout dashboard before Friday.")).toBeVisible();
  });

  it("shows the selected attendee without using it as the card title", () => {
    renderPanel();
    const card = screen.getByRole("article", { name: /Speaker 1/i });

    expect(within(card).getByRole("heading", { name: "Speaker 1" })).toBeVisible();
    expect(within(card).getByLabelText("Who said Speaker 1")).toHaveTextContent(
      "Alex Rivera (alex@example.com)"
    );
    expect(within(card).queryByText("No current mapping")).not.toBeInTheDocument();
  });

  it("dropdown contains participants and current candidates", () => {
    renderPanel();

    const speakerButton = screen.getByLabelText("Who said Speaker 1");
    expect(speakerButton).toHaveTextContent("Alex Rivera (alex@example.com)");

    fireEvent.click(speakerButton);
    expect(screen.getByRole("option", { name: "Unknown" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Alex Rivera/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Jordan Kim/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custom name" })).toBeInTheDocument();
  });

  it("save calls onSave with mapping updates", async () => {
    const { onSave } = renderPanel();

    chooseMapping("SPEAKER_01", /Jordan Kim/i);
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

    chooseMapping("SPEAKER_00", "Unknown");
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

    chooseMapping("SPEAKER_01", "Custom name");
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

    const card = screen.getByRole("article", { name: /Speaker 2/i });
    const speakerButton = within(card).getByLabelText("Who said Speaker 2");

    expect(speakerButton).toHaveTextContent("Custom name");
    fireEvent.click(speakerButton);
    expect(screen.getAllByRole("option", { name: "Custom name" })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Outside Consultant" })).not.toBeInTheDocument();
  });

  it("preserves dirty user edits when refreshed with new mapping props for the same speakers", () => {
    const { props, rerender } = renderPanel();

    chooseMapping("SPEAKER_01", "Custom name");
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

    expect(screen.getByLabelText("Who said Speaker 2")).toHaveTextContent("Custom name");
    expect(screen.getByLabelText("Custom display name")).toHaveValue("Morgan Lee");
  });

  it("warns users when one detected speaker is available for multiple attendees", () => {
    renderPanel({
      segments: [
        {
          speaker: "Joseph Miguel Guerrero",
          raw_speaker: "SPEAKER_00",
          start: 65,
          end: 72,
          text: "Hey, just give me one second while I set up the meeting room.",
        },
      ],
      mappings: [],
      participants: [
        { id: 1, name: "Joseph Miguel Guerrero", email: "joseph@example.com" },
        { id: 2, name: "Daniel Vucetic", email: "daniel@example.com" },
      ],
    });

    expect(screen.getByRole("heading", { name: "Confirm who spoke" })).toBeVisible();
    expect(screen.getByText(/1 speaker label detected for 2 attendees/i)).toBeVisible();
    expect(screen.getByText(/Audio may be merged/i)).toBeVisible();
    expect(screen.queryByText(/Choose Unknown unless you are sure/i)).not.toBeInTheDocument();
    expect(screen.getByText("1:05")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Speaker 1" })).toBeVisible();
    expect(screen.getByText("Detected label: SPEAKER_00")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Joseph Miguel Guerrero" })).not.toBeInTheDocument();
    expect(screen.queryByText("No current mapping")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Who said Speaker 1")).toHaveTextContent("Unknown");
  });
});
