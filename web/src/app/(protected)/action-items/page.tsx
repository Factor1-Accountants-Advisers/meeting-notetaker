"use client";

import { useEffect, useMemo, useState } from "react";

import ActionItemContextPanel from "@/components/action-items/ActionItemContextPanel";
import MeetingActionItemsView from "@/components/action-items/MeetingActionItemsView";
import MeetingRail from "@/components/action-items/MeetingRail";
import { buildMeetingGroups, filterActionItems } from "@/components/action-items/selectors";
import { useActionItems, useMeeting, useMeetings } from "@/lib/api";

const ACTION_ITEMS_PAGE_SIZE = 250;
const MEETINGS_PAGE_SIZE = 500;

const DEFAULT_FILTERS = {
  owner: "",
  search: "",
  status: "all",
} as const;

function getMeetingSummary(summaryText: string | null | undefined): string {
  if (summaryText?.trim()) {
    return summaryText;
  }

  return "No meeting summary available.";
}

export default function ActionItemsPage() {
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null);
  const [selectedActionItemId, setSelectedActionItemId] = useState<number | null>(null);

  const { data: actionItemsData, error: actionItemsError, isLoading: actionItemsLoading } =
    useActionItems(1, ACTION_ITEMS_PAGE_SIZE);
  const { data: meetingsData } = useMeetings(1, MEETINGS_PAGE_SIZE);

  const filteredItems = useMemo(
    () => filterActionItems(actionItemsData?.items ?? [], DEFAULT_FILTERS),
    [actionItemsData?.items]
  );

  const meetingTitles = useMemo(
    () =>
      Object.fromEntries(
        (meetingsData?.items ?? []).map((meeting) => [meeting.id, meeting.title])
      ),
    [meetingsData?.items]
  );

  const meetingGroups = useMemo(
    () =>
      buildMeetingGroups(filteredItems, meetingTitles).map((group) => ({
        ...group,
        title: group.title || `Meeting ${group.meetingId}`,
      })),
    [filteredItems, meetingTitles]
  );

  const effectiveSelectedMeetingId =
    selectedMeetingId != null &&
    meetingGroups.some((group) => group.meetingId === selectedMeetingId)
      ? selectedMeetingId
      : meetingGroups[0]?.meetingId ?? null;

  const selectedMeetingGroup =
    meetingGroups.find((group) => group.meetingId === effectiveSelectedMeetingId) ?? null;

  const effectiveSelectedActionItemId =
    selectedActionItemId != null &&
    selectedMeetingGroup?.items.some((item) => item.id === selectedActionItemId)
      ? selectedActionItemId
      : selectedMeetingGroup?.items[0]?.id ?? null;

  const selectedActionItem =
    selectedMeetingGroup?.items.find((item) => item.id === effectiveSelectedActionItemId) ?? null;

  useEffect(() => {
    setSelectedMeetingId(effectiveSelectedMeetingId);
  }, [effectiveSelectedMeetingId]);

  useEffect(() => {
    setSelectedActionItemId(effectiveSelectedActionItemId);
  }, [effectiveSelectedActionItemId]);

  const {
    data: selectedMeeting,
    error: selectedMeetingError,
    isLoading: selectedMeetingLoading,
  } = useMeeting(effectiveSelectedMeetingId ?? undefined);

  const selectedMeetingTitle = selectedMeeting?.title || selectedMeetingGroup?.title || "Action Items";

  const selectedMeetingSummary = selectedMeetingLoading
    ? "Loading meeting context..."
    : selectedMeetingError
      ? "Unable to load meeting context."
      : getMeetingSummary(selectedMeeting?.summary?.summary_text);

  const actionItemsTruncated =
    (actionItemsData?.total ?? 0) > (actionItemsData?.items.length ?? 0);
  const unresolvedMeetingTitles = meetingGroups.some(
    (group) => !meetingTitles[group.meetingId]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Action Items</h1>
      </div>

      {actionItemsLoading && !actionItemsData ? (
        <div
          role="status"
          className="rounded-[28px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-6 py-10 text-sm text-[color:var(--text-secondary)] shadow-[var(--shadow-soft)]"
        >
          Loading action items...
        </div>
      ) : actionItemsError ? (
        <div
          role="alert"
          className="rounded-[28px] border border-red-500/30 bg-red-500/10 px-6 py-10 text-sm text-red-100"
        >
          Failed to load action items.
        </div>
      ) : meetingGroups.length === 0 ? (
        <div
          role="status"
          className="rounded-[28px] border border-dashed border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] px-6 py-10 text-sm text-[color:var(--text-secondary)] shadow-[var(--shadow-soft)]"
        >
          No action items yet.
        </div>
      ) : (
        <div className="space-y-4">
          {actionItemsTruncated ? (
            <div
              role="status"
              className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
            >
              {`Showing the first ${actionItemsData?.items.length ?? 0} of ${actionItemsData?.total ?? 0} action items.`}
            </div>
          ) : null}

          {unresolvedMeetingTitles ? (
            <div
              role="status"
              className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
            >
              Some visible meetings are using fallback titles because meeting details were not loaded.
            </div>
          ) : null}

          <div className="overflow-hidden rounded-[32px] border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-panel)] xl:grid xl:min-h-[calc(100vh-16rem)] xl:grid-cols-[280px_minmax(0,1fr)_360px]">
            <MeetingRail
              groups={meetingGroups}
              selectedMeetingId={effectiveSelectedMeetingId}
              onSelectMeeting={setSelectedMeetingId}
            />
            <MeetingActionItemsView
              meetingTitle={selectedMeetingTitle}
              items={selectedMeetingGroup?.items ?? []}
              selectedActionItemId={effectiveSelectedActionItemId}
              onSelectActionItem={setSelectedActionItemId}
            />
            <ActionItemContextPanel
              meetingTitle={selectedMeetingTitle}
              meetingSummary={selectedMeetingSummary}
              actionItem={selectedActionItem}
            />
          </div>
        </div>
      )}
    </div>
  );
}
