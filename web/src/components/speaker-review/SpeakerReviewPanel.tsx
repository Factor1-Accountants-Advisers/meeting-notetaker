"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

function safeDomId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "-") || "speaker";
}

function formatTimestamp(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const min = Math.floor(safeSeconds / 60);
  const sec = Math.floor(safeSeconds % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
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
  const [isDirty, setIsDirty] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const speakerLabelsKey = useMemo(() => speakerLabels.join("\u001f"), [speakerLabels]);
  const previousSpeakerLabelsKey = useRef(speakerLabelsKey);
  const detectedFewerSpeakersThanAttendees =
    speakerLabels.length > 0 && participants.length > 1 && speakerLabels.length < participants.length;

  useEffect(() => {
    const speakerLabelsChanged = previousSpeakerLabelsKey.current !== speakerLabelsKey;

    if (!isDirty || speakerLabelsChanged) {
      setSelections(createInitialSelections(mappings, participants, speakerLabels));
      setIsDirty(false);
      previousSpeakerLabelsKey.current = speakerLabelsKey;
    }
  }, [isDirty, mappings, participants, speakerLabels, speakerLabelsKey]);

  const participantByValue = useMemo(
    () => new Map(participants.map((participant) => [participantValue(participant), participant] as const)),
    [participants]
  );

  function updateSelection(speakerLabel: string, value: string) {
    setIsDirty(true);
    setOpenDropdown(null);
    setSelections((current) => ({
      ...current,
      [speakerLabel]: {
        value,
        customName: current[speakerLabel]?.customName ?? "",
      },
    }));
  }

  function updateCustomName(speakerLabel: string, customName: string) {
    setIsDirty(true);
    setSelections((current) => ({
      ...current,
      [speakerLabel]: {
        value: current[speakerLabel]?.value ?? CUSTOM_VALUE,
        customName,
      },
    }));
  }

  function selectionLabel(value: string): string {
    if (value === UNKNOWN_VALUE) {
      return "Unknown";
    }

    if (value === CUSTOM_VALUE) {
      return "Custom name";
    }

    const participant = participantByValue.get(value);
    if (!participant) {
      return "Unknown";
    }

    return participant.email ? `${participant.name} (${participant.email})` : participant.name;
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
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Confirm who spoke</h2>
        <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
          Use the quotes to match each detected speaker label to an attendee.
        </p>
      </div>

      {detectedFewerSpeakersThanAttendees ? (
        <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">
            {speakerLabels.length} speaker label detected for {participants.length} attendees.
          </p>
          <p className="mt-1">Audio may be merged, so only map it if the quotes are clear.</p>
        </div>
      ) : null}

      <div className="grid gap-4">
        {reviewGroups.map((group) => {
          const selection = selections[group.speakerLabel] ?? {
            value: UNKNOWN_VALUE,
            customName: "",
          };
          const safeSpeakerId = safeDomId(group.speakerLabel);
          const headingId = `speaker-review-${safeSpeakerId}`;
          const customInputId = `custom-name-${safeSpeakerId}`;

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
                    {group.quotes.map((quote, quoteIndex) => (
                      <li
                        key={`${group.speakerLabel}-${quoteIndex}-${quote.start}-${quote.text}`}
                        className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 py-2 text-sm text-[color:var(--text-secondary)]"
                      >
                        <span className="mb-1 block text-xs font-semibold text-[color:var(--text-muted)]">
                          {formatTimestamp(quote.start)}
                        </span>
                        {quote.text}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-3">
                  <div className="block text-sm font-medium text-[color:var(--text-primary)]">
                    <span id={`mapping-label-${safeSpeakerId}`}>Mapping for {group.speakerLabel}</span>
                    <div className="relative mt-1">
                      <button
                        aria-controls={`mapping-options-${safeSpeakerId}`}
                        aria-expanded={openDropdown === group.speakerLabel}
                        aria-haspopup="listbox"
                        aria-label={`Mapping for ${group.speakerLabel}`}
                        aria-labelledby={`mapping-label-${safeSpeakerId}`}
                        className="flex h-11 w-full items-center justify-between rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-3 text-left text-sm text-[color:var(--text-primary)] shadow-sm outline-none transition hover:border-[color:var(--border-strong)] focus:border-[color:var(--border-strong)] focus:ring-2 focus:ring-[color:var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isSaving}
                        type="button"
                        onClick={() =>
                          setOpenDropdown((current) =>
                            current === group.speakerLabel ? null : group.speakerLabel
                          )
                        }
                      >
                        <span className="truncate">{selectionLabel(selection.value)}</span>
                        <span aria-hidden="true" className="ml-3 text-[color:var(--text-muted)]">⌄</span>
                      </button>
                      {openDropdown === group.speakerLabel ? (
                        <div
                          id={`mapping-options-${safeSpeakerId}`}
                          role="listbox"
                          aria-label={`Mapping options for ${group.speakerLabel}`}
                          className="mt-2 w-full overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface)] p-1 shadow-[var(--shadow-panel)]"
                        >
                          <button
                            role="option"
                            aria-selected={selection.value === UNKNOWN_VALUE}
                            className="flex w-full rounded-xl px-3 py-2 text-left text-sm text-[color:var(--text-primary)] transition hover:bg-[color:var(--surface-soft)] aria-selected:bg-[color:var(--accent-soft)] aria-selected:text-[color:var(--accent-text)]"
                            type="button"
                            onClick={() => updateSelection(group.speakerLabel, UNKNOWN_VALUE)}
                          >
                            Unknown
                          </button>
                          {participants.map((participant) => {
                            const value = participantValue(participant);
                            return (
                              <button
                                key={participant.id}
                                role="option"
                                aria-selected={selection.value === value}
                                className="flex w-full flex-col rounded-xl px-3 py-2 text-left text-sm text-[color:var(--text-primary)] transition hover:bg-[color:var(--surface-soft)] aria-selected:bg-[color:var(--accent-soft)] aria-selected:text-[color:var(--accent-text)]"
                                type="button"
                                onClick={() => updateSelection(group.speakerLabel, value)}
                              >
                                <span>{participant.name}</span>
                                {participant.email ? (
                                  <span className="text-xs text-[color:var(--text-muted)]">{participant.email}</span>
                                ) : null}
                              </button>
                            );
                          })}
                          <button
                            role="option"
                            aria-selected={selection.value === CUSTOM_VALUE}
                            className="flex w-full rounded-xl px-3 py-2 text-left text-sm text-[color:var(--text-primary)] transition hover:bg-[color:var(--surface-soft)] aria-selected:bg-[color:var(--accent-soft)] aria-selected:text-[color:var(--accent-text)]"
                            type="button"
                            onClick={() => updateSelection(group.speakerLabel, CUSTOM_VALUE)}
                          >
                            Custom name
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>

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
