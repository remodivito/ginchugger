---
name: GinChugger
description: Document-first contract review with visible evidence and explicit guidance.
colors:
  ink: "#25322f"
  muted: "#65716b"
  line: "#dde2dc"
  green: "#205b49"
  pale: "#eaf1ed"
  amber: "#955511"
  paper: "#fffefa"
  red: "#a13e40"
  canvas: "#f5f6f3"
  surface: "#ffffff"
  green-hover: "#164634"
typography:
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "14px"
  document:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "12px"
    lineHeight: 1.85
  document-title:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "30px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.5px"
  matter-title:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    letterSpacing: "-0.4px"
rounded:
  clause: "4px"
  input: "5px"
  button: "6px"
  workspace: "8px"
  dialog: "10px"
spacing:
  button: "8px 11px"
  paper: "40px 44px"
  review: "24px 22px 17px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.surface}"
    rounded: "{rounded.button}"
    padding: "{spacing.button}"
  button-primary-hover:
    backgroundColor: "{colors.green-hover}"
  workspace:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.workspace}"
  paper:
    backgroundColor: "{colors.paper}"
    padding: "{spacing.paper}"
---

> **Superseded on 4 October 2026.** The interface now follows the E2 system in [`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md), with tokens in `src/tokens.css`. What follows describes the earlier interface and is kept for the record only.

# Design System: GinChugger

## Overview

**Creative North Star: "The agreement and its margin"**

Operate mode preserves the agreement as the primary reading surface and keeps assistance close to its evidence. The existing interface is restrained, compact and document-led. This record describes current source code, not a proposed visual redesign or a screenshot reconstruction.

**Key Characteristics:**
- Paper-like agreement surface beside a structured review pane.
- Quiet green actions, amber attention and explicit text labels.
- Source wording and saved guidance remain visually distinct.

## Colors

The incumbent palette combines dark green actions with neutral paper and soft structural dividers. `src/style.css` is the implementation source for the tokens above. Ink supports primary reading; muted text identifies metadata. Green is used for actions and within-guidance states, amber for attention, and muted blue for context. States also have icons and text labels; color alone never communicates approval.

## Typography

The UI declares DM Sans with a sans-serif fallback. Titles declare Newsreader with Georgia fallback; contract text uses Georgia/Times New Roman. DM Sans and Newsreader are bundled from the @fontsource packages by the current entrypoint. No Google Fonts request is made at runtime; installed fallback fonts remain available.

Contract text is 12px at 1.85 line height, increasing to 13px on the widest layout. The document title is 30px, while the matter title is 19px and review titles are 18px. Compact metadata ranges from 9–11px; new surfaces should not increase information density further.

## Layout

The desktop workspace uses `minmax(400px,1fr) 425px`, a viewport-relative height and independent document/review scrolling. The paper is at most 800px wide, with 40px/44px padding. At 1500px and above the review pane grows to 475px and the workspace caps at 1700px. At 1050px and below the review pane is 380px. At 760px and below, Document and Review switches replace the simultaneous columns. The Word pane suppresses the duplicate document surface because Word supplies it.

## Elevation & Depth

Dividers and surface tones carry most hierarchy. The paper uses `0 2px 9px #2335260d`; dialogs use `0 12px 55px #0e211633`; toasts use `0 5px 20px #14281a26`. Shadows identify layers rather than decorate each finding. There is no card grid surrounding routine review items.

## Shapes

Small radii keep controls distinct without dominating the agreement: clauses 4px, inputs 5px, buttons 6px, workspace 8px and dialogs 10px. Finding rows and evidence quotations rely on dividers or a left border instead of rounded containers.

## Components

Primary buttons reserve dark green for explicit actions. Secondary buttons are white with a thin divider-colored border; disabled controls reduce opacity and change the cursor. Focus uses a 2px green outline with 3px offset.

Findings expand in place to expose exact evidence, the relevant rule and reviewer actions. Evidence is a clickable serif quotation on a pale tinted background. Playbook entries are compact rows opening an explicit editor. Tabs and filters use a selected line or tint. The stale banner must remain prominent after document or guidance changes.

Tracked additions use a green tint and underline; deletions use a red tint and strikethrough. Edit previews do not alter the document until the reviewer applies them. Dialogs contain consequential edits; notifications confirm completed actions. The only continuous animation is the 0.8-second loading spinner. Reduced-motion preferences disable animation and smooth scrolling.

## Do's and Don'ts

### Do
- Keep source wording visible while inspecting a finding.
- Use text and icons alongside semantic colors.
- Preserve explicit mode, scope and stale-review indicators.

### Don't
- Turn a guidance match into a contract-approval indicator.
- Replace exact evidence with decorative summary cards.
- Hide the current agreement behind a chat-first workflow.
