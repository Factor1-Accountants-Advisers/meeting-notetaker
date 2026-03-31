import type { ActionItem } from "@/types";

import type { ActionItemsPageFilters, MeetingActionItemsGroup } from "./types";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function filterActionItems(items: ActionItem[], filters: ActionItemsPageFilters): ActionItem[] {
  const owner = normalize(filters.owner);
  const search = normalize(filters.search);

  return items.filter((item) => {
    if (filters.status !== "all" && item.status.toLowerCase() !== filters.status) {
      return false;
    }

    if (owner && !normalize(item.owner_name ?? "").includes(owner)) {
      return false;
    }

    if (!search) {
      return true;
    }

    const haystack = [
      item.description,
      item.owner_name ?? "",
      item.owner_email ?? "",
      item.due_date ?? "",
      item.status,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });
}

export function buildMeetingGroups(
  items: ActionItem[],
  titles: Record<number, string>
): MeetingActionItemsGroup[] {
  const groups = new Map<number, MeetingActionItemsGroup>();

  for (const item of items) {
    const group = groups.get(item.meeting_id);

    if (group) {
      group.items.push(item);
      if (item.status === "complete") {
        group.completedCount += 1;
      } else {
        group.openCount += 1;
      }
      if (item.owner_name && !group.owners.includes(item.owner_name)) {
        group.owners.push(item.owner_name);
      }
      continue;
    }

    groups.set(item.meeting_id, {
      meetingId: item.meeting_id,
      title: titles[item.meeting_id] ?? "",
      items: [item],
      openCount: item.status === "complete" ? 0 : 1,
      completedCount: item.status === "complete" ? 1 : 0,
      owners: item.owner_name ? [item.owner_name] : [],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      owners: Array.from(new Set(group.owners)),
    }))
    .sort((a, b) => {
      if (b.openCount !== a.openCount) {
        return b.openCount - a.openCount;
      }

      return a.title.localeCompare(b.title);
    });
}
