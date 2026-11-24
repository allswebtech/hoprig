# Interface and experience

- Applies when the project has screens (web pages, an admin area, an extension's or a desktop app's windows):
  `full`. `not needed` for an API or backend only, a command-line tool and a library. Mobile apps follow it through
  the mobile reference.
- Light form: when there are no lists or records to manage (for example a content website). The part "Do it on the
  same page" falls away. Everything else stays, also both themes and accessibility.

## Easy for everyone

1. Anyone understands a page in five seconds: the title says what it is, one short line says what you can do.
2. Plain everyday words, no jargon. Main actions show an icon with a text label. Small row icons have a tooltip and
   an accessible name.
3. One primary action per screen, clearly visible.
4. Every main task starts within two taps or clicks of the start screen.

## Do it on the same page

5. Create and edit in a side sheet (a bottom sheet on mobile) or inline, not on a new page.
6. Change a status, assign or delete from the list row itself. Bulk actions for many rows.
7. Search, filters, sort and tabs stay on the page and are saved in the address, so the back button and sharing
   work.
8. Details open in a drawer when the list should stay in view.
9. A separate page only when the content is large or needs its own address (search, sharing).

## Feedback and safety

10. Instant feedback: optimistic updates, buttons show progress and block a double submit, toasts confirm.
11. Reversible actions get Undo instead of "Are you sure?". Irreversible actions get a clear confirm.
12. Forms: the fewest fields, smart defaults, the right input types and autofill, errors next to the field in plain
    words, typed data kept on error.
13. Every view has a loading state (a skeleton in the final layout), an empty one (with the next action), an error
    one (with retry) and an offline one.
14. Global not-found and error pages that help the user get back.

## Look and access

15. Modern, clean and professional: minimal, uncluttered screens and clear navigation.
16. Mobile-first, 320 px to a wide desktop, no sideways scroll, touch targets at least 44 px.
17. Light and dark theme: follows the system, has a toggle, no flash on load.
18. One component kit and its tokens for consistent spacing, type and colour. The same thing uses the same component
    everywhere.
19. Accessibility: full keyboard use, visible focus, labels, alt text, landmarks, `lang`, reduced motion, WCAG AA
    contrast in both themes.
