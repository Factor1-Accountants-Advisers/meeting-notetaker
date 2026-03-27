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

const FETCH_TIMEOUT_MS = 10_000;

const fetcher = async (url: string) => {
  const headers = await authHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) {
      if (r.status === 401) {
        throw new Error("Unauthorized");
      }
      throw new Error(`API error: ${r.status}`);
    }
    return r.json();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Backend unreachable — is the API server running on localhost:8000?");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

export function useMeeting(id: number | undefined): SWRResponse<MeetingDetail> {
  return useSWR(id != null ? `/api/meetings/${id}` : null, fetcher);
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

// --- Upload ---

export interface UploadMeetingParams {
  file: File;
  title: string;
  attendees: { name: string; email: string }[];
  scheduledTime?: string;
}

export interface UploadMeetingResult {
  meeting_id: number;
  status: string;
}

export async function uploadMeeting(
  params: UploadMeetingParams
): Promise<UploadMeetingResult> {
  const headers = await authHeaders();
  const formData = new FormData();
  formData.append("audio_file", params.file);
  formData.append(
    "metadata",
    JSON.stringify({
      meeting_title: params.title,
      attendees: params.attendees,
      scheduled_time: params.scheduledTime || null,
    })
  );

  const res = await fetch("/api/meetings/upload", {
    method: "POST",
    headers,
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Upload failed: ${res.status}`);
  }
  return res.json();
}

// --- Mutations ---

export async function deleteMeeting(id: number): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`/api/meetings/${id}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Delete failed: ${res.status}`);
  }
}

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
