import type { ActionItem } from "@/types";

import type { ActionItemDraft } from "@/components/action-items/types";

function toActionItemDraft(item: ActionItem | null): ActionItemDraft {
  return {
    description: item?.description ?? "",
    owner_name: item?.owner_name ?? "",
    owner_email: item?.owner_email ?? "",
    due_date: item?.due_date ?? "",
    status: item?.status === "complete" ? "complete" : "open",
  };
}

export function createActionItemDraft(item: ActionItem | null): ActionItemDraft {
  return toActionItemDraft(item);
}

export function isActionItemDraftDirty(
  item: ActionItem | null,
  draft: ActionItemDraft
): boolean {
  const baseline = toActionItemDraft(item);
  return (
    baseline.description !== draft.description ||
    baseline.owner_name !== draft.owner_name ||
    baseline.owner_email !== draft.owner_email ||
    baseline.due_date !== draft.due_date ||
    baseline.status !== draft.status
  );
}
