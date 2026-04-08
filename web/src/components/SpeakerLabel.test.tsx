import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SpeakerLabel from "./SpeakerLabel";

// Mock the renameSpeaker API helper
vi.mock("@/lib/api", () => ({
  renameSpeaker: vi.fn().mockResolvedValue({ updated_count: 2 }),
}));

const defaultProps = {
  name: "Speaker A",
  colorClass: "text-blue-400",
  meetingId: 1,
  onRenamed: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SpeakerLabel", () => {
  it("renders speaker name as a span by default", () => {
    render(<SpeakerLabel {...defaultProps} />);
    expect(screen.getByText("Speaker A")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("switches to input on click", () => {
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("Speaker A");
  });

  it("cancels edit on Escape without saving", async () => {
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "John" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Speaker A")).toBeInTheDocument();
    expect(defaultProps.onRenamed).not.toHaveBeenCalled();
  });

  it("saves on Enter and calls onRenamed", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "John Smith" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(renameSpeaker).toHaveBeenCalledWith(1, "Speaker A", "John Smith");
      expect(defaultProps.onRenamed).toHaveBeenCalledWith("Speaker A", "John Smith");
    });
  });

  it("does not save if new name is blank", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameSpeaker).not.toHaveBeenCalled();
  });

  it("does not save if name is unchanged", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameSpeaker).not.toHaveBeenCalled();
  });

  it("shows error state and does not call onRenamed when API fails", async () => {
    const { renameSpeaker } = await import("@/lib/api");
    vi.mocked(renameSpeaker).mockRejectedValueOnce(new Error("Server error"));
    render(<SpeakerLabel {...defaultProps} />);
    fireEvent.click(screen.getByText("Speaker A"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "John Smith" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(renameSpeaker).toHaveBeenCalled();
      expect(defaultProps.onRenamed).not.toHaveBeenCalled();
    });
  });
});
