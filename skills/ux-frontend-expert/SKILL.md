---
name: ux-frontend-expert
description: Expert workflow for frontend UX/UI improvements in web apps. Use when navigation is confusing, visual hierarchy is weak, layout is not responsive, accessibility is missing, design feels inconsistent, or UI flows fail in real usage. Apply for React/HTML/CSS refactors, dashboard cleanup, menu redesign, game launcher UX, and functional frontend validation before release.
---

# UX Frontend Expert

## Overview

Plan and execute pragmatic frontend UX fixes with measurable outcomes: clearer navigation, stronger visual hierarchy, responsive behavior, accessible controls, and verified user flows.

## Workflow

1. Audit current UI and identify top friction points.
2. Define IA and interaction model before coding.
3. Implement visual and structural improvements incrementally.
4. Run functional checks on critical flows.
5. Report concrete before/after results and residual gaps.

## 1) Audit First

Inspect these areas before changing code:
- Navigation depth, labels, and dead-ends.
- Consistency between modules (media, emulator, dashboard).
- Responsiveness in mobile and desktop breakpoints.
- Accessibility basics: focus states, contrast, keyboard path.
- Flow integrity: can users finish key actions without confusion?

Use the checklist in `references/frontend-ux-playbook.md` and prioritize issues by impact on user completion.

## 2) Define UX Contract

Before implementing, write a brief UX contract:
- Primary user goals.
- Entry points and expected path.
- Error/empty/loading states.
- Visual hierarchy (what should draw attention first).
- Acceptance criteria for completion.

## 3) Implement with Strong Frontend Decisions

Apply intentional design decisions:
- Separate unrelated domains in UI; avoid mixed dashboards.
- Keep menu model explicit: section -> console -> game card -> play.
- Use a clear typographic scale and spacing rhythm.
- Maintain a stable color system using CSS variables.
- Prefer explicit labels over ambiguous icon-only controls.

## 4) Validate Functionally

Run functional checks for key paths:
- Home to target module navigation.
- Game open flow from menu and direct route.
- Back/forward behavior.
- Keyboard and pointer interactions.
- HTTP status for critical routes when applicable.

## 5) Deliverable Format

Always report:
- Exact files changed.
- UX problems fixed (mapped to user pain).
- Functional checks executed and outcomes.
- Remaining risks or pending polish.

## References

- `references/frontend-ux-playbook.md`: checklist and acceptance criteria for recurring frontend UX work.
