# Acceptance test notes for the example shopping list

- Each copy starts with an empty list. The fixture in `tests/fixtures.ts` empties it before every test.
- There is one page, `/`: a count of items under the heading, a list of items in the region "Items", and a form "Add item" with the field "Item name" and the button "Add".
- `recordRequests(page, "POST", "/api/items")` records each item the page saves.
- `tests/blank-name.spec.ts` is a worked example.
- Nothing needs sign-in.
