export type ActionItemsLabMode = "workspace" | "kanban";
export type ActionItemsLabStatusFilter = "all" | "open" | "complete";
export type ActionItemsLabDueFilter = "all" | "overdue" | "today" | "week" | "no-due-date";

export interface ActionItemsLabTask {
  id: string;
  title: string;
  owner: string | null;
  dueDate: string | null;
  status: "open" | "complete";
  meetingId: number;
  meetingTitle: string;
  excerpt: string;
}

export interface ActionItemsLabFilters {
  search: string;
  owner: string;
  status: ActionItemsLabStatusFilter;
  due: ActionItemsLabDueFilter;
}

export interface ActionItemsLabSummary {
  open: number;
  dueThisWeek: number;
  overdue: number;
  completed: number;
}

export interface ActionItemsLabBucket {
  id: "overdue" | "today" | "this-week" | "later" | "no-due-date";
  title: string;
  items: ActionItemsLabTask[];
}

export interface ActionItemsLabColumn {
  id: "needs-attention" | "this-week" | "planned" | "done";
  title: string;
  items: ActionItemsLabTask[];
}
