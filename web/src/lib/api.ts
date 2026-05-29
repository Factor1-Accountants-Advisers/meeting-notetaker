import useSWR, { SWRResponse, SWRConfiguration } from "swr";
import type {
  MeetingListResponse,
  MeetingDetail,
  TranscriptResponse,
  ActionItem,
  ActionItemListResponse,
  ActionItemUpdate,
  SpeakerMappingListResponse,
  SpeakerMappingUpdate,
} from "@/types";

export interface ActionItemCreate {
  meeting_id: number;
  description: string;
  owner_name?: string | null;
  owner_email?: string | null;
  due_date?: string | null;
  status?: string;
}

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

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `API error: ${res.status}`);
  }

  return res.json();
}

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

export function useMeeting(
  id: number | undefined,
  options?: SWRConfiguration
): SWRResponse<MeetingDetail> {
  return useSWR(id != null ? `/api/meetings/${id}` : null, fetcher, options);
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

export async function retryMeeting(id: number): Promise<{ meeting_id: number; status: string }> {
  const headers = await authHeaders();
  const res = await fetch(`/api/meetings/${id}/retry`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Retry failed: ${res.status}`);
  }
  return res.json();
}

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

export async function createActionItem(
  payload: ActionItemCreate
): Promise<ActionItem> {
  const headers = await authHeaders();
  const res = await fetch("/api/action-items", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to create action item: ${res.status}`);
  return res.json();
}

export async function deleteActionItem(id: number): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`/api/action-items/${id}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(`Failed to delete action item: ${res.status}`);
}

export async function getSpeakerMappings(
  meetingId: number
): Promise<SpeakerMappingListResponse> {
  return apiFetch<SpeakerMappingListResponse>(`/api/meetings/${meetingId}/speaker-mappings`);
}

export async function updateSpeakerMappings(
  meetingId: number,
  updates: SpeakerMappingUpdate[]
): Promise<SpeakerMappingListResponse> {
  return apiFetch<SpeakerMappingListResponse>(`/api/meetings/${meetingId}/speaker-mappings`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export async function resolveActionOwners(meetingId: number): Promise<ActionItem[]> {
  return apiFetch<ActionItem[]>(`/api/meetings/${meetingId}/resolve-action-owners`, {
    method: "POST",
  });
}

export async function renameSpeaker(
  meetingId: number,
  oldName: string,
  newName: string,
): Promise<{ updated_count: number }> {
  const headers = await authHeaders();
  const res = await fetch(`/api/meetings/${meetingId}/rename-speaker`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ old_name: oldName, new_name: newName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Rename failed: ${res.status}`);
  }
  return res.json();
}
