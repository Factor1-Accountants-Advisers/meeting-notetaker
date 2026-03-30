"use client";

import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { retryMeeting } from "@/lib/api";
import { useSWRConfig } from "swr";
import { useState } from "react";

interface ProcessingProgressProps {
  meetingId: number;
  status: string;
}

type StepState = "done" | "active" | "pending";

interface PipelineStep {
  label: string;
  state: StepState;
}

function getSteps(status: string): PipelineStep[] {
  const steps: { key: string; label: string }[] = [
    { key: "processing", label: "Preparing audio" },
    { key: "transcribing", label: "Transcribing audio" },
    { key: "diarising", label: "Identifying speakers" },
    { key: "summarising", label: "Generating summary & action items" },
  ];

  const statusOrder = ["processing", "transcribing", "diarising", "summarising", "complete"];
  const currentIdx = statusOrder.indexOf(status);

  return steps.map((step) => {
    const stepIdx = statusOrder.indexOf(step.key);
    if (currentIdx > stepIdx) return { label: step.label, state: "done" as const };
    if (currentIdx === stepIdx) return { label: step.label, state: "active" as const };
    return { label: step.label, state: "pending" as const };
  });
}

export default function ProcessingProgress({
  meetingId,
  status,
}: ProcessingProgressProps) {
  const { mutate } = useSWRConfig();
  const [retrying, setRetrying] = useState(false);

  if (status === "complete") return null;

  const isFailed = status === "failed";

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retryMeeting(meetingId);
      await mutate(`/api/meetings/${meetingId}`);
    } catch {
      // error shown via SWR revalidation
    } finally {
      setRetrying(false);
    }
  };

  if (isFailed) {
    return (
      <div className="rounded-[24px] border border-[color:var(--danger-soft)] bg-[color:var(--surface-elevated)] p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2 mb-2">
          <XCircle className="h-5 w-5 text-[color:var(--danger)]" />
          <h3 className="text-sm font-semibold text-[color:var(--danger)]">
            Processing failed
          </h3>
        </div>
        <p className="mb-3 text-xs text-[color:var(--text-secondary)]">
          Something went wrong while processing your meeting. You can try again.
        </p>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="inline-flex h-10 items-center rounded-full bg-[color:var(--danger)] px-4 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {retrying ? "Retrying..." : "Retry Processing"}
        </button>
      </div>
    );
  }

  const steps = getSteps(status);

  return (
    <div className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] p-5 shadow-[var(--shadow-soft)]">
      <div className="flex items-center gap-2 mb-4">
        <Loader2 className="h-5 w-5 animate-spin text-[color:var(--accent-text)]" />
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">
          Processing your meeting...
        </h3>
      </div>

      <div className="space-y-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            {step.state === "done" && (
              <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" />
            )}
            {step.state === "active" && (
              <Loader2 className="h-4 w-4 animate-spin flex-shrink-0 text-[color:var(--accent-text)]" />
            )}
            {step.state === "pending" && (
              <div className="h-4 w-4 flex-shrink-0 rounded-full border border-[color:var(--border-strong)]" />
            )}
            <span
              className={`text-sm ${
                step.state === "done"
                  ? "text-[color:var(--text-secondary)]"
                  : step.state === "active"
                    ? "text-[color:var(--text-primary)]"
                    : "text-[color:var(--text-muted)]"
              }`}
            >
              {step.label}
              {step.state === "active" && "..."}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
