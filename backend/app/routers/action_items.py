from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, status

from app import store
from app.schemas import ActionItem, ActionItemStatus, ActionItemUpdate

Actor = Header("Unknown user", alias="X-MN-User")

router = APIRouter(prefix="/action-items", tags=["action-items"])


@router.get("", response_model=list[ActionItem])
async def list_action_items(
    meeting_id: UUID | None = None,
    status_filter: ActionItemStatus | None = None,
    owner: str | None = None,
) -> list[ActionItem]:
    items = list(store.ACTION_ITEMS.values())
    if meeting_id is not None:
        items = [a for a in items if a.meeting_id == meeting_id]
    if status_filter is not None:
        items = [a for a in items if a.status == status_filter]
    if owner is not None:
        items = [a for a in items if a.owner == owner]
    items = [
        a.model_copy(
            update={
                "meeting_title": (
                    m.title if (m := store.MEETINGS.get(a.meeting_id)) else ""
                )
            }
        )
        for a in items
    ]
    return sorted(items, key=lambda a: (a.deadline is None, a.deadline))


@router.patch("/{item_id}", response_model=ActionItem)
async def update_action_item(
    item_id: UUID, body: ActionItemUpdate, actor: str = Actor
) -> ActionItem:
    item = store.ACTION_ITEMS.get(item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Action item not found")
    changes = body.model_dump(exclude_unset=True)
    updated = item.model_copy(update=changes)
    store.ACTION_ITEMS[item_id] = updated
    def plain(value: object) -> str | None:
        if value is None:
            return None
        return str(getattr(value, "value", value))  # enums -> their value

    for field, new_value in changes.items():
        old_value = getattr(item, field)
        if old_value != new_value:
            store.add_audit(
                actor,
                f"action_item.{field}",
                item.description[:60],
                before=plain(old_value),
                after=plain(new_value),
                meeting_id=item.meeting_id,
            )
    meeting = store.MEETINGS.get(item.meeting_id)
    return updated.model_copy(update={"meeting_title": meeting.title if meeting else ""})
