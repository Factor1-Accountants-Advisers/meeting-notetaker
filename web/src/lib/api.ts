import useSWR, { SWRResponse } from "swr";
import type {
  MeetingListResponse,
  MeetingDetail,
  TranscriptResponse,
  ActionItem,
  ActionItemListResponse,
  ActionItemUpdate,
} from "@/types";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  });

// --- SWR Hooks ---

export function useMeetings(
  page = 1,
  perPage = 20,
  status?: string
): SWRResponse<MeetingListResponse> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (status) params.set("status", status);
  return useSWR(`/api/meetings?${params}`, fetcher);
}

export function useMeeting(id: number): SWRResponse<MeetingDetail> {
  return useSWR(`/api/meetings/${id}`, fetcher);
}

export function useTranscript(id: number): SWRResponse<TranscriptResponse> {
  return useSWR(`/api/meetings/${id}/transcript`, fetcher);
}

export function useMeetingActionItems(id: number): SWRResponse<ActionItem[]> {
  return useSWR(`/api/meetings/${id}/action-items`, fetcher);
}

export function useActionItems(
  page = 1,
  perPage = 20,
  status?: string
): SWRResponse<ActionItemListResponse> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (status) params.set("status", status);
  return useSWR(`/api/action-items?${params}`, fetcher);
}

// --- Mutations ---

export async function updateActionItem(
  id: number,
  update: ActionItemUpdate
): Promise<ActionItem> {
  const res = await fetch(`/api/action-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Failed to update action item: ${res.status}`);
  return res.json();
}
