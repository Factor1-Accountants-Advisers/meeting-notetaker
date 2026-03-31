# Action Items Right Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Action Items right column into a rich verification-and-correction workspace with explicit save/reset/delete controls, while keeping add-task behavior in the middle column.

**Architecture:** Extend the existing split-view Action Items page with minimal new backend action-item mutation endpoints, thin frontend API helpers, and an upgraded right-panel inspector that owns editing plus meeting context. Keep the three-column layout intact: the middle pane owns list-level add/delete entry points, while the right pane owns draft editing and commit/reset flows for the currently selected task.

**Tech Stack:** FastAPI, SQLAlchemy async sessions, Pydantic, Next.js 14 App Router, React 18, SWR, TypeScript, Tailwind CSS, Vitest, Testing Library

---

## File Structure

### New files

- `web/src/components/action-items/inspector-state.ts`
  Small pure helpers for converting `ActionItem` records into editable draft state and comparing dirty values.
- `web/src/components/action-items/inspector-state.test.ts`
  Unit tests for draft initialization and dirty-state detection.

### Modified files

- `backend/app/schemas.py`
  Add create-request schema for action items.
- `backend/app/routers/action_items.py`
  Add `POST /api/action-items` and `DELETE /api/action-items/{id}`.
- `backend/tests/test_read_endpoints.py`
  Extend existing action-item endpoint coverage for create/delete.
- `web/src/lib/api.ts`
  Add `createActionItem()` and `deleteActionItem()` helpers.
- `web/src/components/action-items/types.ts`
  Add frontend draft/form types for the inspector.
- `web/src/components/action-items/ActionItemContextPanel.tsx`
  Upgrade the right panel into a rich editor with `Task Details`, `Meeting Context`, and `Actions`.
- `web/src/components/action-items/ActionItemContextPanel.test.tsx`
  Cover editable fields, save/reset/delete controls, and meeting context rendering.
- `web/src/components/action-items/MeetingActionItemsView.tsx`
  Add middle-pane `Add action item` affordance and row-level delete trigger.
- `web/src/components/action-items/MeetingActionItemsView.test.tsx`
  Cover add/delete UI affordances and their callbacks.
- `web/src/app/(protected)/action-items/page.tsx`
  Wire inspector draft state, mutation handlers, add/delete flows, reset/save behavior, and right-pane scrolling.
- `web/src/app/(protected)/action-items/page.test.tsx`
  Cover right-panel mutation state, save/reset behavior, and list-level add/delete integration.

## Scope Notes

This pass keeps the approved three-column layout and does **not** redesign the left rail.

It adds:

- always-editable right panel
- explicit save/reset/delete actions
- meeting context beneath the task editor
- middle-pane add action item button
- row-level delete affordance

It does **not** add:

- transcript evidence UI
- autosave
- collaborative comments
- bulk edit

## Task 1: Add Backend Action Item Create/Delete Endpoints

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routers/action_items.py`
- Modify: `backend/tests/test_read_endpoints.py`

- [ ] **Step 1: Write the failing backend tests**

Extend `backend/tests/test_read_endpoints.py` with create/delete coverage:

```python
class TestPostActionItem:
    async def test_creates_action_item_for_owned_meeting(self, client):
        resp = await client.post(
            "/api/action-items",
            json={
                "meeting_id": 1,
                "description": "Email revised implementation note",
                "owner_name": "Ava",
                "due_date": "2026-04-04",
                "status": "open",
            },
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["meeting_id"] == 1
        assert body["description"] == "Email revised implementation note"
        assert body["owner_name"] == "Ava"

    async def test_rejects_create_for_other_users_meeting(self, client):
        resp = await client.post(
            "/api/action-items",
            json={"meeting_id": 2, "description": "Should fail"},
        )
        assert resp.status_code == 404


class TestDeleteActionItem:
    async def test_deletes_owned_action_item(self, client):
        resp = await client.delete("/api/action-items/1")
        assert resp.status_code == 204

    async def test_rejects_delete_for_missing_action_item(self, client):
        resp = await client.delete("/api/action-items/999")
        assert resp.status_code == 404
```

- [ ] **Step 2: Run the targeted backend tests to verify failure**

Run:

```bash
cd backend
python -m pytest tests/test_read_endpoints.py -k "PostActionItem or DeleteActionItem" -v
```

Expected: FAIL because the create/delete endpoints and schema do not exist yet.

- [ ] **Step 3: Add the request schema**

Update `backend/app/schemas.py` to add a create schema:

```python
class ActionItemCreate(BaseModel):
    """Action item create request."""
    meeting_id: int
    description: str
    owner_name: Optional[str] = None
    owner_email: Optional[EmailStr] = None
    due_date: Optional[date] = None
    status: str = "open"
```

- [ ] **Step 4: Implement minimal create/delete endpoints**

Update `backend/app/routers/action_items.py`:

```python
from app.schemas import (
    ActionItemCreate,
    ActionItemListResponse,
    ActionItemResponse,
    ActionItemUpdate,
)


@router.post("", response_model=ActionItemResponse, status_code=status.HTTP_201_CREATED)
async def create_action_item(
    payload: ActionItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ActionItemResponse:
    meeting_result = await db.execute(
        select(Meeting).where(
            Meeting.id == payload.meeting_id,
            Meeting.user_id == current_user.id,
        )
    )
    meeting = meeting_result.scalars().first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    action_item = ActionItem(
        meeting_id=payload.meeting_id,
        description=payload.description,
        owner_name=payload.owner_name,
        owner_email=payload.owner_email,
        due_date=payload.due_date,
        status=ActionItemStatus(payload.status),
    )
    db.add(action_item)
    await db.commit()
    await db.refresh(action_item)
    return ActionItemResponse.model_validate(action_item)


@router.delete("/{action_item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_action_item(
    action_item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(ActionItem)
        .join(Meeting, ActionItem.meeting_id == Meeting.id)
        .where(ActionItem.id == action_item_id, Meeting.user_id == current_user.id)
    )
    action_item = result.scalars().first()
    if not action_item:
        raise HTTPException(status_code=404, detail="Action item not found")

    await db.delete(action_item)
    await db.commit()
```

- [ ] **Step 5: Run the targeted backend tests to verify pass**

Run:

```bash
cd backend
python -m pytest tests/test_read_endpoints.py -k "PostActionItem or DeleteActionItem" -v
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/routers/action_items.py backend/tests/test_read_endpoints.py
git commit -m "feat(backend): add action item create and delete endpoints"
```

## Task 2: Add Frontend Draft-State Helpers And Mutation Helpers

**Files:**
- Create: `web/src/components/action-items/inspector-state.ts`
- Create: `web/src/components/action-items/inspector-state.test.ts`
- Modify: `web/src/components/action-items/types.ts`
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Write the failing draft-state tests**

Create `web/src/components/action-items/inspector-state.test.ts`:

```tsx
import { describe, expect, it } from "vitest";

import type { ActionItem } from "@/types";
import {
  createActionItemDraft,
  isActionItemDraftDirty,
} from "@/components/action-items/inspector-state";

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 1,
    meeting_id: 10,
    description: "Review extracted owners",
    owner_name: "Ava",
    owner_email: "ava@example.com",
    due_date: "2026-04-03",
    status: "open",
    created_at: "2026-03-31T00:00:00.000Z",
    updated_at: "2026-03-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("inspector state", () => {
  it("creates editable draft values from an action item", () => {
    const draft = createActionItemDraft(makeItem());
    expect(draft).toEqual({
      description: "Review extracted owners",
      owner_name: "Ava",
      owner_email: "ava@example.com",
      due_date: "2026-04-03",
      status: "open",
    });
  });

  it("detects dirty draft changes", () => {
    const item = makeItem();
    expect(isActionItemDraftDirty(item, createActionItemDraft(item))).toBe(false);
    expect(
      isActionItemDraftDirty(item, {
        ...createActionItemDraft(item),
        owner_name: "Noah",
      })
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the targeted frontend tests to verify failure**

Run:

```bash
cd web
npm test -- src/components/action-items/inspector-state.test.ts
```

Expected: FAIL because the helper file does not exist yet.

- [ ] **Step 3: Add the draft type and helper implementation**

Update `web/src/components/action-items/types.ts`:

```ts
export interface ActionItemDraft {
  description: string;
  owner_name: string;
  owner_email: string;
  due_date: string;
  status: "open" | "complete";
}
```

Create `web/src/components/action-items/inspector-state.ts`:

```ts
import type { ActionItem } from "@/types";
import type { ActionItemDraft } from "./types";

export function createActionItemDraft(item: ActionItem | null): ActionItemDraft {
  return {
    description: item?.description ?? "",
    owner_name: item?.owner_name ?? "",
    owner_email: item?.owner_email ?? "",
    due_date: item?.due_date ?? "",
    status: item?.status === "complete" ? "complete" : "open",
  };
}

export function isActionItemDraftDirty(
  item: ActionItem | null,
  draft: ActionItemDraft
): boolean {
  if (!item) return false;

  return (
    item.description !== draft.description ||
    (item.owner_name ?? "") !== draft.owner_name ||
    (item.owner_email ?? "") !== draft.owner_email ||
    (item.due_date ?? "") !== draft.due_date ||
    item.status !== draft.status
  );
}
```

- [ ] **Step 4: Add frontend create/delete API helpers**

Update `web/src/lib/api.ts`:

```ts
export interface ActionItemCreate {
  meeting_id: number;
  description: string;
  owner_name?: string | null;
  owner_email?: string | null;
  due_date?: string | null;
  status?: string;
}

export async function createActionItem(payload: ActionItemCreate): Promise<ActionItem> {
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
```

- [ ] **Step 5: Run the targeted frontend tests to verify pass**

Run:

```bash
cd web
npm test -- src/components/action-items/inspector-state.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/action-items/types.ts web/src/components/action-items/inspector-state.ts web/src/components/action-items/inspector-state.test.ts web/src/lib/api.ts
git commit -m "feat(web): add action item inspector state helpers"
```

## Task 3: Upgrade The Right Panel Into A Structured Editor

**Files:**
- Modify: `web/src/components/action-items/ActionItemContextPanel.tsx`
- Modify: `web/src/components/action-items/ActionItemContextPanel.test.tsx`

- [ ] **Step 1: Write the failing inspector test**

Extend `web/src/components/action-items/ActionItemContextPanel.test.tsx` with a form-driven test:

```tsx
it("renders editable task fields with save and reset actions", () => {
  render(
    <ActionItemContextPanel
      meetingTitle="Weekly design review"
      meetingSummary="Reviewed extraction quality and corrections."
      actionItem={{
        id: 101,
        description: "Confirm vendor shortlist and next steps",
        owner_name: "Ava",
        due_date: "2026-04-03",
        status: "open",
      }}
      draft={{
        description: "Confirm vendor shortlist and next steps",
        owner_name: "Ava",
        owner_email: "",
        due_date: "2026-04-03",
        status: "open",
      }}
      isDirty={false}
      isSaving={false}
      onDraftChange={() => {}}
      onSave={() => {}}
      onReset={() => {}}
      onDelete={() => {}}
    />
  );

  expect(screen.getByLabelText("Task description")).toBeVisible();
  expect(screen.getByLabelText("Owner")).toHaveValue("Ava");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
});
```

- [ ] **Step 2: Run the targeted component test to verify failure**

Run:

```bash
cd web
npm test -- src/components/action-items/ActionItemContextPanel.test.tsx
```

Expected: FAIL because the panel still renders read-only metadata.

- [ ] **Step 3: Implement the richer structured editor**

Update `web/src/components/action-items/ActionItemContextPanel.tsx` so it accepts draft props and renders three sections:

```tsx
type ActionItemContextPanelProps = {
  meetingTitle: string;
  meetingSummary: string;
  actionItem: {
    id: number;
    description: string;
    owner_name: string | null;
    due_date: string | null;
    status: string;
  } | null;
  draft: ActionItemDraft;
  isDirty: boolean;
  isSaving: boolean;
  onDraftChange: (patch: Partial<ActionItemDraft>) => void;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
};
```

Render shape:

```tsx
<aside className="h-full overflow-y-auto border-t ... xl:border-l xl:border-t-0">
  <div className="space-y-6 p-1">
    <section>
      <h2>Task details</h2>
      <label>
        <span>Task description</span>
        <textarea
          value={draft.description}
          onChange={(e) => onDraftChange({ description: e.target.value })}
        />
      </label>
      <label>
        <span>Owner</span>
        <input
          value={draft.owner_name}
          onChange={(e) => onDraftChange({ owner_name: e.target.value })}
        />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span>Due date</span>
          <input
            type="date"
            value={draft.due_date}
            onChange={(e) => onDraftChange({ due_date: e.target.value })}
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={draft.status}
            onChange={(e) => onDraftChange({ status: e.target.value as "open" | "complete" })}
          >
            <option value="open">Open</option>
            <option value="complete">Complete</option>
          </select>
        </label>
      </div>
    </section>

    <section>
      <h2>Meeting context</h2>
      <h3>{meetingTitle}</h3>
      <p>{meetingSummary}</p>
    </section>

    <section>
      <button disabled={!isDirty || isSaving} onClick={onSave}>Save changes</button>
      <button disabled={!isDirty || isSaving} onClick={onReset}>Reset</button>
      <button disabled={!actionItem || isSaving} onClick={onDelete}>Delete task</button>
    </section>
  </div>
</aside>
```

- [ ] **Step 4: Run the targeted component test to verify pass**

Run:

```bash
cd web
npm test -- src/components/action-items/ActionItemContextPanel.test.tsx src/components/action-items/inspector-state.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items/ActionItemContextPanel.tsx web/src/components/action-items/ActionItemContextPanel.test.tsx
git commit -m "feat(web): turn action items context panel into editor"
```

## Task 4: Add Middle-Pane Add/Delete List Controls

**Files:**
- Modify: `web/src/components/action-items/MeetingActionItemsView.tsx`
- Modify: `web/src/components/action-items/MeetingActionItemsView.test.tsx`

- [ ] **Step 1: Write the failing middle-pane controls test**

Extend `web/src/components/action-items/MeetingActionItemsView.test.tsx`:

```tsx
it("renders add and delete controls for meeting-level task management", () => {
  const onAddActionItem = vi.fn();
  const onDeleteActionItem = vi.fn();

  render(
    <MeetingActionItemsView
      meetingTitle="Weekly design review"
      items={[makeItem()]}
      selectedActionItemId={101}
      onSelectActionItem={() => {}}
      onAddActionItem={onAddActionItem}
      onDeleteActionItem={onDeleteActionItem}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Add action item" }));
  fireEvent.click(screen.getByRole("button", { name: /delete confirm vendor shortlist/i }));

  expect(onAddActionItem).toHaveBeenCalled();
  expect(onDeleteActionItem).toHaveBeenCalledWith(101);
});
```

- [ ] **Step 2: Run the targeted component test to verify failure**

Run:

```bash
cd web
npm test -- src/components/action-items/MeetingActionItemsView.test.tsx
```

Expected: FAIL because the middle pane does not expose add/delete controls yet.

- [ ] **Step 3: Implement list-level add/delete affordances**

Update `web/src/components/action-items/MeetingActionItemsView.tsx` props:

```tsx
export default function MeetingActionItemsView({
  meetingTitle,
  items,
  selectedActionItemId,
  onSelectActionItem,
  onAddActionItem,
  onDeleteActionItem,
}: {
  meetingTitle: string;
  items: ActionItem[];
  selectedActionItemId: number | null;
  onSelectActionItem: (id: number) => void;
  onAddActionItem: () => void;
  onDeleteActionItem: (id: number) => void;
}) {
```

Render an add button in the header and a small delete button per row:

```tsx
<div className="border-b ... px-6 py-5">
  <div className="flex items-center justify-between gap-4">
    <h2 className="text-2xl font-semibold ...">{meetingTitle}</h2>
    <button type="button" onClick={onAddActionItem} className="rounded-full ...">
      Add action item
    </button>
  </div>
</div>
```

Per row:

```tsx
<div className="flex items-start justify-between gap-4">
  <p className="min-w-0 text-sm font-medium ...">{item.description}</p>
  <button
    type="button"
    aria-label={`Delete ${item.description}`}
    onClick={(e) => {
      e.stopPropagation();
      onDeleteActionItem(item.id);
    }}
    className="rounded-full ..."
  >
    Delete
  </button>
</div>
```

- [ ] **Step 4: Run the targeted component test to verify pass**

Run:

```bash
cd web
npm test -- src/components/action-items/MeetingActionItemsView.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/action-items/MeetingActionItemsView.tsx web/src/components/action-items/MeetingActionItemsView.test.tsx
git commit -m "feat(web): add action item list controls"
```

## Task 5: Integrate Right-Panel Draft State And Mutations In The Route

**Files:**
- Modify: `web/src/app/(protected)/action-items/page.tsx`
- Modify: `web/src/app/(protected)/action-items/page.test.tsx`

- [ ] **Step 1: Write the failing route tests**

Extend `web/src/app/(protected)/action-items/page.test.tsx` with mutation-focused coverage:

```tsx
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    useActionItems: vi.fn(),
    useMeetings: vi.fn(),
    useMeeting: vi.fn(),
    updateActionItem: vi.fn(),
    createActionItem: vi.fn(),
    deleteActionItem: vi.fn(),
  };
});

it("enables save after editing the selected task draft", async () => {
  renderPage();

  fireEvent.change(screen.getByLabelText("Owner"), {
    target: { value: "Noah" },
  });

  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

it("creates a blank task for the selected meeting from the middle pane", async () => {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Add action item" }));
  expect(mockedCreateActionItem).toHaveBeenCalledWith(
    expect.objectContaining({
      meeting_id: 7,
      description: "New action item",
      status: "open",
    })
  );
});
```

- [ ] **Step 2: Run the targeted route test to verify failure**

Run:

```bash
cd web
npm test -- "src/app/(protected)/action-items/page.test.tsx"
```

Expected: FAIL because the route does not yet manage drafts or create/delete flows.

- [ ] **Step 3: Implement route-level draft and mutation wiring**

Update `web/src/app/(protected)/action-items/page.tsx`:

```tsx
import { useSWRConfig } from "swr";
import { createActionItemDraft, isActionItemDraftDirty } from "@/components/action-items/inspector-state";
import type { ActionItemDraft } from "@/components/action-items/types";
import {
  createActionItem,
  deleteActionItem,
  updateActionItem,
  useActionItems,
  useMeeting,
  useMeetings,
} from "@/lib/api";
```

State:

```tsx
const { mutate } = useSWRConfig();
const [draft, setDraft] = useState<ActionItemDraft>(createActionItemDraft(null));
const [isSaving, setIsSaving] = useState(false);
```

Sync draft when selection changes:

```tsx
useEffect(() => {
  setDraft(createActionItemDraft(selectedActionItem));
}, [selectedActionItem]);
```

Handlers:

```tsx
async function refreshActionItems() {
  await mutate((key: string) => typeof key === "string" && key.includes("/api/action-items"));
  if (effectiveSelectedMeetingId) {
    await mutate(`/api/meetings/${effectiveSelectedMeetingId}`);
  }
}

async function handleSave() {
  if (!selectedActionItem) return;
  setIsSaving(true);
  try {
    await updateActionItem(selectedActionItem.id, {
      description: draft.description,
      owner_name: draft.owner_name || null,
      owner_email: draft.owner_email || null,
      due_date: draft.due_date || null,
      status: draft.status,
    });
    await refreshActionItems();
  } finally {
    setIsSaving(false);
  }
}

function handleReset() {
  setDraft(createActionItemDraft(selectedActionItem));
}

async function handleAddActionItem() {
  if (!effectiveSelectedMeetingId) return;
  setIsSaving(true);
  try {
    const created = await createActionItem({
      meeting_id: effectiveSelectedMeetingId,
      description: "New action item",
      status: "open",
    });
    await refreshActionItems();
    setSelectedActionItemId(created.id);
  } finally {
    setIsSaving(false);
  }
}

async function handleDeleteActionItem(id: number) {
  setIsSaving(true);
  try {
    await deleteActionItem(id);
    await refreshActionItems();
    if (selectedActionItem?.id === id) {
      setSelectedActionItemId(null);
    }
  } finally {
    setIsSaving(false);
  }
}
```

Pass props:

```tsx
<MeetingActionItemsView
  ...
  onAddActionItem={handleAddActionItem}
  onDeleteActionItem={handleDeleteActionItem}
/>

<ActionItemContextPanel
  ...
  draft={draft}
  isDirty={isActionItemDraftDirty(selectedActionItem, draft)}
  isSaving={isSaving}
  onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
  onSave={handleSave}
  onReset={handleReset}
  onDelete={() => selectedActionItem && handleDeleteActionItem(selectedActionItem.id)}
/>
```

Also update the outer three-column shell to allow right-pane scrolling:

```tsx
<div className="... xl:grid xl:h-[calc(100vh-16rem)] xl:grid-cols-[280px_minmax(0,1fr)_360px]">
```

- [ ] **Step 4: Run the targeted route and component tests to verify pass**

Run:

```bash
cd web
npm test -- "src/app/(protected)/action-items/page.test.tsx" src/components/action-items/MeetingActionItemsView.test.tsx src/components/action-items/ActionItemContextPanel.test.tsx src/components/action-items/inspector-state.test.ts
```

Expected: PASS

- [ ] **Step 5: Run lint**

Run:

```bash
cd web
npm run lint
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add "web/src/app/(protected)/action-items/page.tsx" "web/src/app/(protected)/action-items/page.test.tsx" web/src/components/action-items web/src/lib/api.ts
git commit -m "feat(web): add action items verification workspace"
```

## Self-Review

### Spec coverage

- Right panel becomes a richer structured editor: covered by Task 3.
- Right panel combines editing plus meeting context: covered by Task 3 and Task 5.
- Explicit `Save changes`, `Reset`, and low-emphasis `Delete task`: covered by Task 3 and Task 5.
- Add/delete ownership split with add in middle and delete available from list + panel: covered by Task 4 and Task 5.
- Three-column layout remains intact: preserved in Task 5.

### Placeholder scan

- No `TODO` / `TBD` placeholders remain.
- Every task includes exact files, commands, and test intent.
- Backend create/delete work is explicitly planned rather than implied.

### Type consistency

- Draft type is consistently named `ActionItemDraft`.
- Right-panel component continues to be `ActionItemContextPanel` in this plan to minimize churn.
- Frontend mutation helpers are consistently named `createActionItem`, `updateActionItem`, and `deleteActionItem`.
