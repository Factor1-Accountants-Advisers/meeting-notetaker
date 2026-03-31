# Action Items Right Panel

**Date:** 2026-03-31  
**Status:** Approved  
**Branch:** current working tree

## Problem

The Action Items page now has the right three-column structure, but the right panel still needs a stronger product role.

If it only mirrors editable fields, it is not clearly worth the screen space. The panel should justify itself by helping users verify and correct AI-extracted tasks while remembering what happened in the source meeting.

## Goal

Turn the right column into a production-grade verification and correction workspace for the currently selected task.

The panel should help a user:

1. edit the selected task
2. verify the task against meeting context
3. commit or discard corrections confidently

## Decision

Keep the three-column layout:

- **Left:** `Meetings`
- **Middle:** action-item list for the selected meeting
- **Right:** rich task editor with meeting context

The right panel is justified because it combines two jobs:

1. task correction
2. source-meeting verification

Without the context half, the panel would be too weak to deserve a dedicated column.

## Column Responsibilities

### Left Column

Purpose:

- choose the source meeting
- search and browse meetings with action items

This column remains meeting-level navigation only.

### Middle Column

Purpose:

- review all extracted tasks from the selected meeting
- add missing tasks
- browse and select a task to inspect

This column owns list-level operations:

- `Add action item`
- row-level delete affordance or row menu

### Right Column

Purpose:

- inspect and correct the selected task
- validate it against meeting context

This column does **not** own adding new tasks. It is scoped to the currently selected item.

## Recommended Structure

The right panel should be a richer structured editor, not a metadata card.

### Section 1: Task Details

Primary editing surface.

Fields:

- task description
- owner
- due date
- status

Design notes:

- editable controls should be visible by default
- the task description should be the most visually prominent field
- this section should feel like a real form, not read-only metadata rows

### Section 2: Meeting Context

Secondary verification surface.

Content:

- source meeting title
- short meeting summary
- optional meeting link later
- optional transcript evidence later

Design notes:

- visually quieter than the task editor
- enough context to help users remember the meeting without leaving the page
- this section is what makes the right panel valuable in an AI-correction workflow

### Section 3: Actions

Bottom action area.

Controls:

- primary `Save changes`
- secondary `Reset`
- low-emphasis danger `Delete task`

Design notes:

- use explicit save, not auto-save
- users may make several corrections before committing
- explicit save is safer and more trustworthy for AI-generated content

## Interaction Model

### Editing

- the right panel is always editable
- selecting a different task updates the panel to that task
- dirty state should be preserved or explicitly guarded later if the implementation supports it

### Adding Tasks

Adding belongs in the middle column because it is a list-level action.

Recommended placement:

- `Add action item` button in the middle-panel header

### Deleting Tasks

Delete can appear in two places:

- subtle row action in the middle list
- low-emphasis danger action in the right panel footer

This gives both quick list cleanup and deliberate destructive control in the detail workspace.

## Why This Direction

Three directions were considered:

1. keep a right panel and make it a richer editor plus meeting context
2. remove the right panel and do all editing inline in the middle list
3. use a drawer/modal for editing instead of a persistent right column

The recommended option is **1**.

Why:

- inline-only editing weakens verification because users lose meeting context while correcting AI output
- a drawer/modal adds repeated open/close friction for triage
- a persistent right workspace makes the three-column layout earn its complexity

## Product Rationale

This page is not a generic task manager. It is an AI-assisted correction surface for meeting-derived action items.

That means the right panel should optimize for:

- confidence
- verification
- correction speed

The user should be able to say:

- “The AI got the owner wrong”
- “The due date was interpreted incorrectly”
- “This task description should be rewritten”
- “I remember the meeting now, this should be saved like this”

without leaving the Action Items page.

## Out of Scope

Not part of this design pass:

- transcript evidence UI
- autosave
- version history
- collaborative comments
- bulk edit behavior
- redesigning the left or middle columns beyond the ownership split described here

## Success Criteria

The right-panel pass succeeds if:

1. the panel clearly feels worth the screen space
2. users can edit the selected task directly without mode switching
3. users can verify edits using nearby meeting context
4. add/delete responsibilities feel naturally split between the middle and right columns
