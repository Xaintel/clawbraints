# Frontend UX Playbook

## Quick Checklist

- Navigation labels are explicit and consistent.
- Module boundaries are clear (no mixed concepts in one panel).
- Main CTA is obvious in first viewport.
- Empty/loading/error states are visible and actionable.
- Mobile and desktop layout both preserve usability.
- Keyboard navigation works for primary actions.
- Color contrast is readable for core content.

## Information Architecture

1. Define the top-level sections first.
2. Keep section names user-oriented, not implementation-oriented.
3. Limit primary nav options to reduce cognitive load.
4. Prefer progressive disclosure over dense all-in-one screens.

## Visual Hierarchy Rules

1. One primary action per screen context.
2. Use spacing and scale to group related controls.
3. Keep labels concise and unambiguous.
4. Avoid decorative effects that reduce readability.

## Emulator UX Pattern

1. Console selector as first decision.
2. Game grid with covers as second decision.
3. Single clear play action per card.
4. Keep direct routes stable for TV remote shortcuts.
5. Preserve back navigation path: game -> console -> home.

## Functional Validation

1. Verify entry route loads (`200` or expected redirect).
2. Verify primary flow end-to-end without manual hacks.
3. Verify deep-link routes for direct access.
4. Verify browser back/forward does not break state.
5. Verify at least one path with keyboard only.

## Definition of Done

- User can complete primary flow with no ambiguity.
- No broken navigation links in core screens.
- UI remains usable at common desktop and mobile widths.
- Changes are documented with file list and test evidence.
