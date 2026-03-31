import type { ActionItem } from "@/types";

export interface ActionItemsPageFilters {
  owner: string;
  status: "all" | "open" | "complete";
  search: string;
}

export interface MeetingActionItemsGroup {
  meetingId: number;
  title: string;
  items: ActionItem[];
  openCount: number;
  completedCount: number;
  owners: string[];
}
