"""Action item endpoints.

Handles listing, creating, updating, and deleting action items across meetings.
"""
import logging
from typing import Optional
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.core.database import get_db
from app.api.dependencies import get_current_user
from app.models import User, Meeting, ActionItem, ActionItemStatus, ActionOwnerSource
from app.schemas import (
    ActionItemCreate,
    ActionItemListResponse,
    ActionItemResponse,
    ActionItemUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/action-items", tags=["action-items"])


def _serialize_action_item(action_item: ActionItem) -> ActionItemResponse:
    return ActionItemResponse(
        id=action_item.id,
        meeting_id=action_item.meeting_id,
        description=action_item.description,
        owner_name=action_item.owner_name,
        owner_email=action_item.owner_email,
        owner_confidence=action_item.owner_confidence,
        owner_source=(
            action_item.owner_source.value
            if action_item.owner_source is not None and hasattr(action_item.owner_source, "value")
            else action_item.owner_source
        ),
        owner_reason=action_item.owner_reason,
        due_date=action_item.due_date,
        status=action_item.status.value,
        created_at=action_item.created_at,
        updated_at=action_item.updated_at,
    )


@router.get("", response_model=ActionItemListResponse)
async def list_action_items(
    page: int = 1,
    per_page: int = 20,
    status_filter: Optional[str] = Query(None, alias="status"),
    due_before: Optional[date] = None,
    due_after: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ActionItemListResponse:
    """List all action items for the authenticated user across all meetings.

    Security: Only returns action items from meetings owned by the user.
    """
    # Join through Meeting to enforce user ownership
    base = (
        select(ActionItem)
        .join(Meeting, ActionItem.meeting_id == Meeting.id)
        .where(Meeting.user_id == current_user.id)
    )

    if status_filter:
        base = base.where(ActionItem.status == ActionItemStatus(status_filter))
    if due_before:
        base = base.where(ActionItem.due_date <= due_before)
    if due_after:
        base = base.where(ActionItem.due_date >= due_after)

    # Count
    count_q = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # Fetch page
    offset = (page - 1) * per_page
    result = await db.execute(
        base.order_by(ActionItem.created_at.desc())
        .offset(offset)
        .limit(per_page)
    )
    items = result.scalars().all()

    return ActionItemListResponse(
        items=[_serialize_action_item(ai) for ai in items],
        total=total,
        page=page,
        per_page=per_page,
        has_next=(offset + per_page) < total,
    )


@router.post("", response_model=ActionItemResponse, status_code=status.HTTP_201_CREATED)
async def create_action_item(
    payload: ActionItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ActionItemResponse:
    """Create an action item for a meeting owned by the authenticated user."""
    result = await db.execute(
        select(Meeting).where(
            Meeting.id == payload.meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    meeting = result.scalars().first()

    if not meeting:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Meeting not found",
        )

    try:
        status_value = ActionItemStatus(payload.status)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status. Allowed: {', '.join(s.value for s in ActionItemStatus)}",
        )

    action_item = ActionItem(
        meeting_id=payload.meeting_id,
        description=payload.description,
        owner_name=payload.owner_name,
        owner_email=payload.owner_email,
        due_date=payload.due_date,
        status=status_value,
    )
    db.add(action_item)
    await db.commit()
    await db.refresh(action_item)

    return _serialize_action_item(action_item)


@router.patch("/{action_item_id}", response_model=ActionItemResponse)
async def update_action_item(
    action_item_id: int,
    update: ActionItemUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ActionItemResponse:
    """Update an action item (status, owner, due_date, description).

    Security: Verifies the action item belongs to a meeting owned by the user.
    """
    # Fetch with ownership check via join
    result = await db.execute(
        select(ActionItem)
        .join(Meeting, ActionItem.meeting_id == Meeting.id)
        .where(
            ActionItem.id == action_item_id,
            Meeting.user_id == current_user.id,
        )
    )
    action_item = result.scalars().first()

    if not action_item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Action item not found",
        )

    # Validate status if provided
    if update.status is not None:
        try:
            ActionItemStatus(update.status)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status. Allowed: {', '.join(s.value for s in ActionItemStatus)}",
            )

    # Apply updates
    update_data = update.model_dump(exclude_unset=True)
    owner_was_updated = "owner_name" in update_data or "owner_email" in update_data
    owner_email_was_provided = "owner_email" in update_data

    for field, value in update_data.items():
        if field == "status" and value is not None:
            setattr(action_item, field, ActionItemStatus(value))
        else:
            setattr(action_item, field, value)

    if owner_was_updated:
        owner_name = (action_item.owner_name or "").strip()
        owner_email = (action_item.owner_email or "").strip()

        if not owner_name and not owner_email_was_provided:
            action_item.owner_email = None
            owner_email = ""

        owner_present = bool(owner_name or owner_email)
        action_item.owner_source = (
            ActionOwnerSource.USER_CORRECTED if owner_present else ActionOwnerSource.UNASSIGNED
        )
        action_item.owner_confidence = 1.0 if owner_present else 0.0
        action_item.owner_reason = (
            "User corrected action owner" if owner_present else "User cleared action owner"
        )

    await db.commit()
    await db.refresh(action_item)

    return _serialize_action_item(action_item)


@router.delete("/{action_item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_action_item(
    action_item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Delete an action item belonging to one of the authenticated user's meetings."""
    result = await db.execute(
        select(ActionItem)
        .join(Meeting, ActionItem.meeting_id == Meeting.id)
        .where(
            ActionItem.id == action_item_id,
            Meeting.user_id == current_user.id,
        )
    )
    action_item = result.scalars().first()

    if not action_item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Action item not found",
        )

    await db.delete(action_item)
    await db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)
