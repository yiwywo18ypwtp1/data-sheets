# Data Sheets

A simplified Airtable: typed columns, an editable virtualized grid over 50 000 rows, formulas with a dependency graph, saved views and a CSV import wizard. Built with Next.js 16 (App Router), React 19, TypeScript strict and SQLite. The task statement is in [frontend-task-data-sheets.md](frontend-task-data-sheets.md); design decisions and measurements are in [ARCHITECTURE.md](ARCHITECTURE.md).

**Scope: Core, Advanced and Bonus** (kanban, cell history, streamed CSV export, offline mode, comments with mentions). The limitations are listed [at the end](#not-done).

## Running it

Requires **Node.js 22+** (`nvm use` reads `.nvmrc`). On older Node the native SQLite module crashes the server silently, so the scripts refuse to start.

```bash
npm install
npm run dev            # http://localhost:3000, redirects to Orders
# or a production build:
npm run build && npm start
```

On first start the database `data/data-sheets.db` is created and seeded. That takes about 1.5 s: 3 linked tables (Orders 50 000 × 30 fields, Customers 5 000, Products 500), 5 formulas, 2 lookups and 3 views per table. `npm run db:reset` deletes it, and the next request seeds it again.

Users are switched on **/settings** (a cookie): Cora Creator (creator, the default), Eddie Editor (editor: edits records and saves views) and Vera Viewer (viewer: read-only). The server checks the role on every write; the UI only hides what you can't do.

### Environment

| Variable | Default | Effect |
|---|---|---|
| `DATABASE_PATH` | `data/data-sheets.db` | SQLite file (`:memory:` in tests) |
| `SEED_SCALE` | `1` | Row-count multiplier for the seed, e.g. `0.1` for a quick start |
| `MOCK_LATENCY_MS` | `0` | Delay added to every `/api` request |
| `MOCK_FAILURE_RATE` | `0` | Share (0–1) of `/api` requests that fail with 503 `MOCK_FAILURE` |
| `MOCK_NOW` | real clock | Pins "now" for `TODAY()` and "today" filters (ISO date-time) |
| `REALTIME_DROP_RATE` | `0` | Share (0–1) of live realtime events the server drops; clients notice the gap and get them replayed |

### Scripts

```bash
npm test            # unit, API and component (React Testing Library) tests, Vitest, ~3 s
npm run test:tz     # the same in Pacific/Auckland and America/Los_Angeles (both always run)
npm run test:e2e    # Playwright: builds, starts on :3100 with a fresh database, runs the 4 scenarios
                    # (uses the installed Google Chrome; or `npx playwright install chromium` and drop `channel`)
npm run typecheck   # next typegen + tsc --noEmit
npm run lint
```

## Checking it by hand

### The grid (`/b/bas_demo/tbl_orders/viw_orders_all`)

- **Scrolling.** Scroll to the end: rows load in windows of 100 (DevTools → Network: `rows?offset=…&limit=100`), the first column and the header stay put, and the footer shows the count and sums.
- **Selection and keys.** Click, then shift-click or Shift+arrows. Click a header for a column, a row number for a row. Arrows, Tab, Enter (edit / commit and move down), Escape, typing to replace, Delete for a range, Cmd/Ctrl+Home/End, PageUp/PageDown.
- **Editors.** Number "1 234,5" (uk-UA locale), dates in the field's zone, select with search, link with record search. An invalid value keeps the editor open with the reason.
- **Copy and paste.** Copy a range and paste it into Google Sheets, then back. Paste one column into a 5-column selection and it's repeated. Pasting past the last row offers to add rows. Values that can't be converted get a red frame and a tooltip; they are never emptied silently.
- **Undo.** Cmd+Z undoes a whole paste in one step, Shift+Cmd+Z redoes it. Edit row 1, scroll to the end, press Cmd+Z: the edit is undone and the grid scrolls back to it.
- **Failures.** Restart with `MOCK_FAILURE_RATE=0.5` and edit a few cells: a batch that fails as a whole (503) stays queued and is sent again ("Offline · N changes waiting"). Cells the server rejects (e.g. a number over the field's max via the API) roll back with a red frame; the other cells keep their edits.
- **Fill.** Select 10 and 20 in a number column and drag the small square at the selection's corner down: 30, 40, 50. Dates continue the same way; one value or text is copied. Cmd/Ctrl+D fills the selection from its top row. One Cmd+Z undoes the fill.
- **Rows and columns.** "+ Add record"; select rows and delete them; Cmd+Z brings them back with the same values and in the same place (links that pointed to them from other tables aren't restored). Column menu (⋯): move, hide. Drag a header edge to resize. Order, widths and hidden fields are saved to the view at once.

### Realtime: two tabs (or two users from /settings in two browsers)

- Both tabs show "Live" and each other's avatar. Selecting a cell in one shows a frame in the other.
- An edit in one tab appears in the other within about 100 ms. Edits of different cells of one row merge.
- Edit the same cell in both, one after the other: the tab whose value was overwritten gets a toast with both values and "Keep mine".
- Delete a record in one tab while the other is editing it: the editor closes with an explanation. Delete a field the other tab is filtering by: its draft resets with an explanation.
- DevTools → Network → Offline, edit, back online: the edits are sent and reach the other tab.
- `REALTIME_DROP_RATE=0.3 npm start`, then edit for a minute in both tabs: both end up showing the same values (gaps are detected and replayed, at the latest by the 5 s heartbeat).

### Views: "Filter & sort"

- Add conditions and a condition group (AND/OR). The operators depend on the field type. Changing the field resets the operator and value; switching "contains" → "is" keeps the text.
- The grid follows after 300 ms. "between" with min > max shows an error and isn't applied.
- "Unsaved view changes" appears with Save view / Reset. Save, reload: the same view. Viewers can filter but not save.
- While the filter is unsaved, the URL carries it (`?filter=<base64>`): "Copy link with filter" and open it in another tab, which shows the same rows with the filter as an unsaved change. A link whose filter doesn't fit the table (`?filter=garbage`) opens the saved view with a notice.
- Sorts are reordered by dragging the ⠿ handle, or with ↑/↓ from the keyboard.
- "+ Add group": group by Status, then by Paid. Group headers show the value, the count and the sums of numeric columns; ▾ collapses a group. Scrolling stays virtualized with groups expanded or collapsed. Moving the selection into a collapsed group (arrows, undo) expands it.

### Fields and formulas (as a creator)

- "+ Add field" → Formula. Type `{Total} - {Prise}`: you get `Unknown field "Prise" at 10` with the spot underlined. Fix it: the result type and a preview on 5 rows appear.
- The formula is highlighted as you type (fields, functions, strings, numbers; unknown fields in red). `{` suggests fields, letters suggest functions: ↑/↓, Enter or Tab to insert.
- Save it as **Net** = `ROUND({Total} * 0.8, 2)`, then edit **Total** to `{Net} + 1`: `Circular reference: Total → Net → Total`.
- Rename **Qty**: Subtotal still works. Delete **Shipping**: the dialog lists Total as dependent; "Delete anyway", and Total shows `#REF!`.
- Change a field's type (column menu → Edit field): the dialog shows how many values convert and which become empty, with examples, before "Convert field". Text → single select creates the options from the values. Date ↔ date-time, one link instead of several and removing select options convert the same way. Changing a link's table isn't supported.

### CSV import (toolbar → "Import CSV", creator only)

- A Windows-1251 file with `;` (or UTF-8 with BOM): the encoding and delimiter are detected and can be overridden; the first 50 rows are shown. Files over 20 MB are refused before reading.
- Columns are matched to fields by name. Two columns can't go into one field. New fields get a suggested type.
- The check step lists invalid values. Fix one in place, then choose "skip rows" or "import as empty". The result shows imported / skipped / imported with empty values / rejected, plus a CSV report.
- A 20 MB file (about 180 000 rows) parses in a worker with progress. Cancel during the import and continue: no row is imported twice (each batch has an idempotency key).
- Close the tab mid-import and open the import page again: "Resume" continues where it stopped (the file and choices are kept in IndexedDB), and the total matches the file exactly.
- Link columns (e.g. Customer in Orders) match records by their name, case-insensitively. Names with no record are errors, or, with "Create the N … values that have no record", new records created before the rows.

### Public forms

- In a table, "+" next to the view tabs → Form. The form view shows its settings: title, description, questions (add, ↑/↓, required, hint) and "show only if" an earlier checkbox or select answer is one of some values. Save, then "Open the form ↗" (`/f/<viewId>`; anyone with the link can answer).
- The public page is cached and refreshed when the view or the table's fields change. Answers are checked with a zod schema built from the questions on the page and again in the Server Action.
- A double click (try `MOCK_LATENCY_MS=3000`) creates one record: every submission carries an id chosen when the form opens. Change the table's fields while a guest is filling the form: their submit is refused with an explanation, the form reloads, and their answers stay. A hidden honeypot field and a limit of 5 submissions per minute per IP keep simple spam out. `POST /api/forms/:viewId` does the same for API clients.

### Edge cases from section 8

| Case | Result |
|---|---|
| `?filter=garbage`, `offset=-1`, `limit=100000` on `/api/tables/tbl_orders/rows` | 400 with `fieldErrors` |
| a view of another table: `/b/bas_demo/tbl_orders/viw_customers_all` or `rows?viewId=viw_customers_all` | 404 (real status for pages too, see `src/proxy.ts`) |
| `{A} / 0`, `IF({Empty}, 1)` | `#DIV/0!` in the cell; empty |
| a cycle through three fields | refused on save with the path |
| a field of another table in a formula | `Unknown field` (use a lookup) |
| 200 nested brackets / `1+1+…` of 10 000 characters (5 000 operators) | both work; 600 nested brackets are refused with a position, no stack overflow |
| `SUM({Qty}, "a")`, `{Qty} + "abc"`, `DATEADD({Start}, 1, "fortnight")`, `DATEADD(5, 1, "days")` | refused on save with a position (a text field may hold a number, so it passes; a literal that can never work does not) |
| `TODAY()` formulas ("days to due") and filters on them after midnight | the first read of a new day recomputes them, without a new record revision |
| a 100 000-character string | formulas are limited to 10 000 characters; a 100 000-character text value works (`LEN` is tested) |
| rename / delete a field a formula uses | keeps working / 409 → confirm → `#REF!` |
| 3 × 1 000 pasted cells with invalid values; 1 column into 5 | invalid ones highlighted; repeated across the 5 |
| `text` → `number` where 30% aren't numbers; then back | the preview counts converted / emptied values with examples; after "Convert field" the non-numbers are empty; converting back gives the numbers as text |
| `2026-03-29 02:30` / `2026-10-25 02:30` in Europe/Berlin | "doesn't exist (clocks skip it)" / the first of the two instants |
| CSV in Windows-1251 with `;` and BOM; 20 MB; close the tab mid-import and open it again | detected; parsed in a worker; "Resume" finishes it without duplicates |
| filter by a formula that uses a lookup, then edit the linked record | the server recomputes lookups and formulas of linking rows; the filter applies on the next load of the view |
| scroll to the end, Cmd+Z | undoes the early edit and scrolls to it |
| two tabs: one deletes a row the other is editing / a field the other filters by | the editor closes / the draft resets, each with an explanation |
| `REALTIME_DROP_RATE=0.3`, a minute of edits | both tabs converge (checked: 60 edits from 2 tabs, identical to the server) |
| public form: double submit with `MOCK_LATENCY_MS=3000` | one record |
| public form: the schema changes while a guest fills it in | the submit is refused with an explanation; the form reloads with the new questions and keeps the answers |

## Not done

- **Bonus** is implemented but has no Playwright scenarios, and the offline mode (service worker, IndexedDB outbox and row copies) was only unit-tested, not driven in a browser. Offline works for tables opened before; unsent edits are taken over by the next tab through Web Locks.

Known limitations:
- Footer sums update on the next window load, not on every edit.
- An open cell editor closes if its row scrolls out of the rendered range.
- Delete and copy of a full column work only for loaded rows (copy fetches the missing ones).
- Lookups display the target's raw text (not locale-formatted).
- A schema change remounts the grid, which drops the undo history and the panel's unsaved draft.
- Undo of a deletion restores the records, but not links to them from other tables.
- `TODAY()` is evaluated in UTC, and refreshed by the first read of the table's base each UTC day (and on every write), not on a timer: a server that nobody reads doesn't refresh, and open grids pick the new values up on their next reload.
- Offset windows: after an edit that moves a row in the current sort (or a row added by someone), a row can repeat or be skipped at a block boundary until the windows reload.
- Realtime presence and rate limits live in the server's memory (one process), as a mock would.
