"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  Participant,
  SpeakerMapping,
  SpeakerMappingUpdate,
  TranscriptSegment,
} from "@/types";
import { groupSegmentsForReview } from "@/components/speaker-review/speakerReview";

export type SpeakerReviewPanelProps = {
  segments: TranscriptSegment[];
  mappings: SpeakerMapping[];
  participants: Participant[];
  isSaving?: boolean;
  onSave: (updates: SpeakerMappingUpdate[]) => Promise<void> | void;
};

type SelectionState = {
  value: string;
  customName: string;
};

const UNKNOWN_VALUE = "unknown";
const CUSTOM_VALUE = "custom";
const CONFIRM_REASON = "Confirmed in speaker review panel";
const UNKNOWN_REASON = "Marked unknown in speaker review panel";
const CUSTOM_REASON = "Entered custom display name in speaker review panel";

function participantValue(participant: Participant): string {
  if (participant.email) {
    return `participant:${participant.email}`;
  }

  return `participant-id:${participant.id}`;
}

function formatSource(source: SpeakerMapping["source"]): string {
  return source.replace(/_/g, " ");
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}% confidence`;
}

function findParticipantForMapping(
  mapping: SpeakerMapping | null,
  participants: Participant[]
): Participant | undefined {
  if (!mapping) {
    return undefined;
  }

  if (mapping.email) {
    const byEmail = participants.find((participant) => participant.email === mapping.email);
    if (byEmail) {
      return byEmail;
    }
  }

  if (mapping.display_name) {
    return participants.find((participant) => participant.name === mapping.display_name);
  }

  return undefined;
}

function createInitialSelections(
  mappings: SpeakerMapping[],
  participants: Participant[],
  speakerLabels: string[]
): Record<string, SelectionState> {
  const mappingByLabel = new Map(mappings.map((mapping) => [mapping.speaker_label, mapping] as const));

  return speakerLabels.reduce<Record<string, SelectionState>>((acc, speakerLabel) => {
    const mapping = mappingByLabel.get(speakerLabel) ?? null;
    const mappedParticipant = findParticipantForMapping(mapping, participants);

    if (mappedParticipant) {
      acc[speakerLabel] = {
        value: participantValue(mappedParticipant),
        customName: mapping?.display_name ?? mappedParticipant.name,
      };
      return acc;
    }

    if (mapping?.display_name) {
      acc[speakerLabel] = {
        value: CUSTOM_VALUE,
        customName: mapping.display_name,
      };
      return acc;
    }

    acc[speakerLabel] = {
      value: UNKNOWN_VALUE,
      customName: "",
    };
    return acc;
  }, {});
}

export default function SpeakerReviewPanel({
  segments,
  mappings,
  participants,
  isSaving = false,
  onSave,
}: SpeakerReviewPanelProps) {
  const reviewGroups = useMemo(
    () => groupSegmentsForReview(segments, mappings),
    [segments, mappings]
  );
  const speakerLabels = useMemo(
    () => reviewGroups.map((group) => group.speakerLabel),
    [reviewGroups]
  );
  const [selections, setSelections] = useState<Record<string, SelectionState>>(() =>
    createInitialSelections(mappings, participants, speakerLabels)
  );

  useEffect(() => {
    setSelections(createInitialSelections(mappings, participants, speakerLabels));
  }, [mappings, participants, speakerLabels]);

  const participantByValue = useMemo(
    () => new Map(participants.map((participant) => [participantValue(participant), participant] as const)),
    [participants]
  );

  function updateSelection(speakerLabel: string, value: string) {
    setSelections((current) => ({
      ...current,
      [speakerLabel]: {
        value,
        customName:
          value === CUSTOM_VALUE
            ? current[speakerLabel]?.customName ?? ""
            : current[speakerLabel]?.customName ?? "",
      },
    }));
  }

  function updateCustomName(speakerLabel: string, customName: string) {
    setSelections((current) => ({
      ...current,
      [speakerLabel]: {
        value: current[speakerLabel]?.value ?? CUSTOM_VALUE,
        customName,
      },
    }));
  }

  async function handleSave() {
    const updates: SpeakerMappingUpdate[] = reviewGroups.map((group) => {
      const selection = selections[group.speakerLabel] ?? {
        value: UNKNOWN_VALUE,
        customName: "",
      };

      if (selection.value === UNKNOWN_VALUE) {
        return {
          speaker_label: group.speakerLabel,
          display_name: null,
          email: null,
          confidence: 1,
          source: "user_corrected",
          reason: UNKNOWN_REASON,
        };
      }

      if (selection.value === CUSTOM_VALUE) {
        const displayName = selection.customName.trim() || null;
        return {
          speaker_label: group.speakerLabel,
          display_name: displayName,
          email: null,
          confidence: 1,
          source: "user_corrected",
          reason: displayName ? CUSTOM_REASON : UNKNOWN_REASON,
        };
      }

      const participant = participantByValue.get(selection.value);
      return {
        speaker_label: group.speakerLabel,
        display_name: participant?.name ?? null,
        email: participant?.email ?? null,
        confidence: 1,
        source: "user_corrected",
        reason: CONFIRM_REASON,
      };
    });

    await onSave(updates);
  }

  if (reviewGroups.length === 0) {
    return (
      <section
        aria-label="Speaker review"
        className="rounded-[24px] border border-dashed border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-5 text-sm text-[color:var(--text-muted)]"
      >
        No speakers found for review.
      </section>
    );
  }

  return (
    <section aria-label="Speaker review" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Review speakers</h2>
        <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
          Map diarized speaker labels to attendees or mark them as unknown.
        </p>
      </div>

      <div className="grid gap-4">
        {reviewGroups.map((group) => {
          const selection = selections[group.speakerLabel] ?? {
            value: UNKNOWN_VALUE,
            customName: "",
          };
          const headingId = `speaker-review-${group.speakerLabel}`;
          const customInputId = `custom-name-${group.speakerLabel}`;

          return (
            <article
              key={group.speakerLabel}
              aria-labelledby={headingId}
              className="rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] p-5 shadow-[var(--shadow-soft)]"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 id={headingId} className="text-base font-semibold text-[color:var(--text-primary)]">
                    {group.speakerLabel}
                  </h3>
                  {group.mapping ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--text-secondary)]">
                      <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1 font-medium text-[color:var(--text-primary)]">
                        {group.mapping.display_name ?? "Unknown"}
                      </span>
                      {group.mapping.email ? <span>{group.mapping.email}</span> : null}
                      <span className="rounded-full bg-[color:var(--accent-soft)] px-2.5 py-1 text-[color:var(--accent-text)]">
                        {formatConfidence(group.mapping.confidence)}
                      </span>
                      <span className="rounded-full bg-[color:var(--surface-soft)] px-2.5 py-1">
                        {formatSource(group.mapping.source)}
                      </span>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-[color:var(--text-muted)]">No current mapping</p>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                    Representative quotes
                  </h4>
                  <ul className="mt-2 space-y-2">
                    {group.quotes.map((quote) => (
                      <li
                        key={quote}
                        className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 py-2 text-sm text-[color:var(--text-secondary)]"
                      >
                        {quote}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-3">
                  <label className="block text-sm font-medium text-[color:var(--text-primary)]">
                    <span>Mapping for {group.speakerLabel}</span>
                    <select
                      aria-label={`Mapping for ${group.speakerLabel}`}
                      className="mt-1 h-11 w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-primary)] outline-none focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isSaving}
                      value={selection.value}
                      onChange={(event) => updateSelection(group.speakerLabel, event.target.value)}
                    >
                      <option value={UNKNOWN_VALUE}>Unknown</option>
                      {participants.map((participant) => (
                        <option key={participant.id} value={participantValue(participant)}>
                          {participant.email
                            ? `${participant.name} (${participant.email})`
                            : participant.name}
                        </option>
                      ))}
                      {group.mapping?.display_name &&
                      !findParticipantForMapping(group.mapping, participants) ? (
                        <option value={CUSTOM_VALUE}>{group.mapping.display_name}</option>
                      ) : null}
                      <option value={CUSTOM_VALUE}>Custom name</option>
                    </select>
                  </label>

                  {selection.value === CUSTOM_VALUE ? (
                    <label
                      htmlFor={customInputId}
                      className="block text-sm font-medium text-[color:var(--text-primary)]"
                    >
                      Custom display name
                      <input
                        id={customInputId}
                        className="mt-1 h-11 w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isSaving}
                        placeholder="Enter display name"
                        type="text"
                        value={selection.customName}
                        onChange={(event) => updateCustomName(group.speakerLabel, event.target.value)}
                      />
                    </label>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="flex justify-end">
        <button
          className="inline-flex h-11 items-center rounded-full bg-[color:var(--surface-inverse)] px-5 text-sm font-semibold text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isSaving}
          type="button"
          onClick={handleSave}
        >
          {isSaving ? "Saving..." : "Save mappings"}
        </button>
      </div>
    </section>
  );
}
