import type {
  ActionItemsLabBucket,
  ActionItemsLabColumn,
  ActionItemsLabFilters,
  ActionItemsLabSummary,
  ActionItemsLabTask,
} from "./types";

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function parseDueDate(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function dayDiff(dueDate: Date, today: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((startOfDay(dueDate).getTime() - startOfDay(today).getTime()) / msPerDay);
}

function matchesDueFilter(task: ActionItemsLabTask, due: ActionItemsLabFilters["due"], today: Date): boolean {
  const parsed = parseDueDate(task.dueDate);

  if (due === "all") return true;
  if (due === "no-due-date") return parsed === null;
  if (!parsed) return false;

  const diff = dayDiff(parsed, today);

  if (due === "overdue") return diff < 0 && task.status === "open";
  if (due === "today") return diff === 0;
  if (due === "week") return diff >= 0 && diff <= 6;

  return true;
}

export function filterTasks(
  tasks: ActionItemsLabTask[],
  filters: ActionItemsLabFilters,
  today: Date
): ActionItemsLabTask[] {
  const search = filters.search.trim().toLowerCase();
  const owner = filters.owner.trim().toLowerCase();

  return tasks.filter((task) => {
    if (filters.status !== "all" && task.status !== filters.status) return false;
    if (!matchesDueFilter(task, filters.due, today)) return false;
    if (owner && !(task.owner ?? "").toLowerCase().includes(owner)) return false;
    if (!search) return true;

    const haystack = [task.title, task.meetingTitle, task.owner ?? "", task.excerpt].join(" ").toLowerCase();
    return haystack.includes(search);
  });
}

export function buildSummary(tasks: ActionItemsLabTask[], today: Date): ActionItemsLabSummary {
  return tasks.reduce<ActionItemsLabSummary>(
    (summary, task) => {
      const due = parseDueDate(task.dueDate);
      const diff = due ? dayDiff(due, today) : null;

      if (task.status === "complete") {
        summary.completed += 1;
        return summary;
      }

      if (task.dueDate !== null || task.owner !== null) {
        summary.open += 1;
      }

      if (diff !== null && diff < 0) summary.overdue += 1;
      if (diff !== null && diff >= 0 && diff <= 6) summary.dueThisWeek += 1;
      return summary;
    },
    { open: 0, dueThisWeek: 0, overdue: 0, completed: 0 }
  );
}

export function buildWorkspaceBuckets(tasks: ActionItemsLabTask[], today: Date): ActionItemsLabBucket[] {
  const buckets: ActionItemsLabBucket[] = [
    { id: "overdue", title: "Overdue", items: [] },
    { id: "today", title: "Today", items: [] },
    { id: "this-week", title: "This Week", items: [] },
    { id: "later", title: "Later", items: [] },
    { id: "no-due-date", title: "No Due Date", items: [] },
  ];

  for (const task of tasks) {
    if (task.status === "complete") continue;

    const due = parseDueDate(task.dueDate);
    if (!due) {
      buckets[4].items.push(task);
      continue;
    }

    const diff = dayDiff(due, today);
    if (diff < 0) buckets[0].items.push(task);
    else if (diff === 0) buckets[1].items.push(task);
    else if (diff <= 6) buckets[2].items.push(task);
    else buckets[3].items.push(task);
  }

  return buckets;
}

export function buildKanbanColumns(tasks: ActionItemsLabTask[], today: Date): ActionItemsLabColumn[] {
  const columns: ActionItemsLabColumn[] = [
    { id: "needs-attention", title: "Needs Attention", items: [] },
    { id: "this-week", title: "This Week", items: [] },
    { id: "planned", title: "Planned", items: [] },
    { id: "done", title: "Done", items: [] },
  ];

  for (const task of tasks) {
    if (task.status === "complete") {
      columns[3].items.push(task);
      continue;
    }

    const due = parseDueDate(task.dueDate);
    if (!due) {
      columns[2].items.push(task);
      continue;
    }

    const diff = dayDiff(due, today);
    if (diff <= 0 || task.owner === null) columns[0].items.push(task);
    else if (diff <= 6) columns[1].items.push(task);
    else columns[2].items.push(task);
  }

  return columns;
}
