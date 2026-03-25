import useSWR, { SWRResponse } from "swr";
import type {
  MeetingListResponse,
  MeetingDetail,
  TranscriptResponse,
  ActionItem,
  ActionItemListResponse,
  ActionItemUpdate,
} from "@/types";

// --- Token injection ---

let _getIdToken: (() => Promise<string>) | null = null;

/**
 * Register the token provider. Called once from AuthGuard
 * after MSAL is initialized.
 */
export function setTokenProvider(fn: () => Promise<string>) {
  _getIdToken = fn;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!_getIdToken) return {};
  try {
    const token = await _getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

// --- Fetcher ---

const fetcher = async (url: string) => {
  const headers = await authHeaders();
  const r = await fetch(url, { headers });
  if (!r.ok) {
    if (r.status === 401) {
      throw new Error("Unauthorized");
    }
    throw new Error(`API error: ${r.status}`);
  }
  return r.json();
};

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
  const headers = await authHeaders();
  const res = await fetch(`/api/action-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Failed to update action item: ${res.status}`);
  return res.json();
}
