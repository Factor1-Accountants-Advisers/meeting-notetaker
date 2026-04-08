import type { ActionItem } from "@/types";

export interface ActionItemsPageFilters {
  owner: string;
  status: "all" | "open" | "complete";
  search: string;
}

export interface ActionItemDraft {
  description: string;
  owner_name: string;
  owner_email: string;
  due_date: string;
  status: "open" | "complete";
}

export interface MeetingActionItemsGroup {
  meetingId: number;
  title: string;
  items: ActionItem[];
  openCount: number;
  completedCount: number;
  owners: string[];
}
