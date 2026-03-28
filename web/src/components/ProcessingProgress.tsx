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
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-center gap-2 mb-2">
          <XCircle className="w-5 h-5 text-red-400" />
          <h3 className="text-sm font-semibold text-red-300">
            Processing failed
          </h3>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Something went wrong while processing your meeting. You can try again.
        </p>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="px-4 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-700 rounded-lg transition-colors"
        >
          {retrying ? "Retrying..." : "Retry Processing"}
        </button>
      </div>
    );
  }

  const steps = getSteps(status);

  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
        <h3 className="text-sm font-semibold text-blue-300">
          Processing your meeting...
        </h3>
      </div>

      <div className="space-y-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            {step.state === "done" && (
              <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
            )}
            {step.state === "active" && (
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
            )}
            {step.state === "pending" && (
              <div className="w-4 h-4 rounded-full border border-gray-700 flex-shrink-0" />
            )}
            <span
              className={`text-sm ${
                step.state === "done"
                  ? "text-gray-400"
                  : step.state === "active"
                    ? "text-gray-200"
                    : "text-gray-600"
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
