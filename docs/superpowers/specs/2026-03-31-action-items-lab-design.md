# Action Items Lab Prototype

**Date:** 2026-03-31
**Status:** Approved
**Branch:** current working tree

## Problem

The current Action Items page is visually out of step with the rest of the app and too literal for the job it needs to do.

1. Light mode readability is weak because the page still relies on hardcoded gray utility classes instead of the shared theme tokens used by the dashboard.
2. The owner filter input and status dropdown look like generic controls rather than first-class product UI.
3. The page is a thin table view, which is poor for personal execution. Users need help deciding what to act on now, what is overdue, and where each task came from.

## Goal

Create a browser-only localhost prototype that compares two production-grade Action Items layouts without changing the desktop app navigation or replacing the current shipped page.

The prototype should answer one product question: which layout better supports personal execution of tasks extracted from meetings?

## Decision

Build a separate preview route in the Next.js app, referred to here as the **Action Items Lab**.

- The route lives in the web app only and is opened in a browser on localhost.
- It does not replace the existing Action Items tab.
- It renders two layouts inside one page with a segmented toggle:
  - `Workspace`
  - `Kanban`
- Both modes use the same mock data, same filters, same summary strip, and same design tokens so the comparison is fair.

## Why This Direction

Three directions were considered:

1. **Workspace + Kanban lab on one page** (recommended)
2. Split-screen comparison with both layouts visible at once
3. Workspace-only prototype first, Kanban later

The one-page lab wins because it keeps the visual baseline consistent while still letting the user compare two different working models quickly. Split-screen makes both layouts feel cramped and less realistic. Building only one view first slows decision-making.

## Prototype Surface

The prototype should feel like a real product screen rather than a detached demo.

- It should use the existing authenticated web app styling system and shared tokens.
- It should be opened directly in the browser on localhost.
- It should not appear in desktop app navigation.
- It should not require backend changes.

The browser-based visual workflow is explicitly in scope here. The user wants to inspect a localhost mockup outside the Electron shell, and this route provides that surface cleanly.

## Information Architecture

The page has four layers:

### 1. Header

- Title: `Action Items`
- Supporting copy focused on execution rather than extraction
- Segmented toggle for `Workspace` and `Kanban`

### 2. Summary Strip

Four summary cards visible in both modes:

- `Open`
- `Due This Week`
- `Overdue`
- `Completed`

These cards establish context before the user scans individual tasks.

### 3. Shared Filter Bar

The filter controls should visually match the dashboard rather than raw browser controls.

Filters:

- Search
- Owner
- Status
- Due-date quick filter

These controls remain the same in both modes so the layout comparison focuses on task presentation, not changing filter logic.

### 4. Mode Body

The lower content area switches between two layouts.

## Workspace Mode

This is the recommended primary model.

Purpose:

- Help a user decide what to do next
- Make urgency obvious
- Preserve traceability back to the source meeting without overwhelming the main view

Layout:

- Main content grouped into due-date buckets:
  - `Overdue`
  - `Today`
  - `This Week`
  - `Later`
  - `No Due Date`
- Tasks appear as rich rows or compact cards rather than spreadsheet rows
- Each item shows:
  - checkbox
  - task description
  - owner
  - due date
  - source meeting
- Selecting a task opens a right-side detail drawer on desktop-width browser screens

The drawer should show:

- full task text
- owner
- due date
- status
- source meeting link or label
- optional short meeting context snippet if useful in the mockup

## Kanban Mode

This is the alternative planning-oriented model.

Purpose:

- Make task management feel more visual and motivational
- Support scanning work as a set of planning buckets rather than a chronological queue

Columns:

- `Needs Attention`
- `This Week`
- `Planned`
- `Done`

Cards should show:

- task description
- owner chip
- due-date chip
- source meeting chip or caption

The Kanban view should feel more spacious and expressive than Workspace mode, but it is still secondary in the recommendation because it is less precise for reviewing many extracted tasks quickly.

## Visual Direction

The prototype should inherit the current warm-neutral app direction and improve consistency.

- Use the shared CSS variables and surface patterns already established in the dashboard
- Prefer soft borders, elevated cards, large radii, and restrained accent usage
- Avoid generic raw dark controls inside light mode
- Prioritize scan-friendly typography and spacing
- Keep the page polished enough to feel production-grade, not like a wireframe

The visual language should reinforce that Action Items belongs to the same product family as Meetings.

## Data Strategy

Use mock data for the prototype.

Requirements for the mock data:

- include open and completed tasks
- include overdue tasks
- include tasks due this week and later
- include tasks with no due date
- include tasks with and without owners
- include realistic source meeting names

This is important because action-item layouts fail when tested only with clean, ideal data.

## Interaction Scope

In scope for the prototype:

- mode switching
- filter styling and local filtering behavior
- summary cards
- task selection
- right-side detail drawer
- visually realistic task states

Out of scope for the prototype:

- backend persistence
- drag-and-drop
- editing mutations
- desktop app integration
- replacing the current Action Items page

## Success Criteria

The prototype succeeds if it makes the following easy to judge:

1. Whether `Workspace` or `Kanban` better supports personal execution
2. Whether the shared filter and summary system feels visually aligned with the rest of the app
3. Whether the new presentation is clearly better than the current table page for reviewing extracted tasks

## Implementation Note

If the prototype is approved after review, the next step is to write an implementation plan before coding. The likely first implementation target is a dedicated web route such as `/action-items-lab`, leaving the current Action Items tab untouched during exploration.
