# Architecture

Next.js 16 App Router (`cacheComponents`), React 19, SQLite through `better-sqlite3`. One Node process serves pages, Route Handlers (the mock API) and Server Actions.

## Server / client split

| Part | Where | Why |
|---|---|---|
| Layout, base/table/view tabs, role badge | Server Components | Static markup; reads the DB and the user cookie directly |
| Grid page shell + **first 100 rows** | Server (`[viewId]/page.tsx`) | The grid paints with data, without waiting for a client fetch |
| Grid, selection, editors, clipboard, undo | Client (`features/grid`) | Pointer and keyboard interaction, 60 fps scrolling |
| View panel, field dialog, formula editor | Client (React Hook Form) | Live validation and previews |
| CSV import wizard | Client + Web Worker; rows go to a **Server Action** | Parsing 20 MB must not block the page; the action is the mutation boundary |
| Data API (`/api/...`) | Route Handlers | The task's REST contract with one error format (`server/api.ts`) |
| Id checks for `/b/...` URLs | `src/proxy.ts` | Pages stream, so a `notFound()` inside one would answer 200. The proxy checks the ids first, so these URLs get real 404s and 307s |

`lib/` is isomorphic: domain zod schemas, the formula engine, value coercion and import mapping. The client and the server import the same code, so the editor, paste, import and the server all validate the same way.

## Data model and storage

`tables.fields` and `views.config` are JSON columns, because they are always read and written whole. A row is one JSON object (`rows.cells`, keyed by field id) plus `rev`, `seq` (creation order) and formula errors. Filters and sorts compile to `json_extract` SQL (`server/filterSql.ts`). Every value and every JSON path is a bound parameter. Values are stored locale-neutral: numbers, `YYYY-MM-DD` dates, UTC ISO date-times, option ids. Only display is localized.

## Client grid state

`GridStore` is a plain class read through `useSyncExternalStore`. Each row component subscribes to its own row, its own selection slice and its editing column, so loading a window or moving the selection re-renders only the affected rows. A store without React is easy to unit-test. Zustand would wrap the same hook in an extra dependency.

- **Windows.** Rows are loaded in blocks of 100 for the visible range plus overscan. Loading is debounced by 50 ms, so dragging the scrollbar doesn't fetch every block it passes. Requests are aborted when their block leaves the range, and answers from an older query (`generation`) are dropped.
- **Memory.** At most 12 blocks (1 200 rows) are kept. When more are loaded, the blocks furthest from the viewport are evicted. Rows with unsaved edits are kept until the server answers.
- **Writes.** Edits apply optimistically and queue as `update` ops. Everything written in one tick, such as a whole paste, goes out as one batch. Batches are sent one at a time, so the server sees edits in the user's order. The server answers per op. A failed op rolls back only its own cells, which get a red frame with the reason.
- **Undo.** The history stores `before`/`after` per cell, and one user action (an edit, a clear, or a 10 000-cell paste) is one entry. Undo writes the `before` values back as a normal edit and scrolls to them, even from the other end of the table.
- **Views.** `useSavedView` saves the column layout (instantly, debounced) and the view panel's filter and sorts (on "Save view") through one queue with `If-Match`. On a 412 it re-applies its own part on top of the newer version.

## Formulas

The pipeline is lexer → Pratt parser → type checker → evaluator (`lib/formula`). Each stage reports errors with a 0-based position (`Unknown field "Prise" at 8`).

- **Stored by id.** The editor works with `{Name}`; the stored expression uses `{fld_id}`, so renaming a field breaks nothing. A field deleted with `force` leaves its id in the expression, and the formula evaluates to `#REF!`.
- **Types.** Results are `text | number | date | checkbox`. Runtime errors (`#DIV/0!`, `#VALUE!`) are values that propagate, not exceptions. A result is normalised to the declared type (no float noise, so a filter `= 4680.65` matches).
- **Graph.** Edges come from formula references, lookups → their link field and the target field in the other table. A cycle is checked on save across all tables and reported with its path (`Total → Tax → Total`).
- **Recompute.** On a cell write, the server recomputes only the dependents of the changed fields, in topological order. It then propagates through lookups to rows of other tables that link to the changed rows, once per batch rather than once per op. The client recomputes same-row formulas optimistically with the same engine. After a schema change every row of the affected fields is recomputed in one transaction.
- **Limits.** 10 000 characters and 512 nesting levels; each operator in a chain counts as a level, so the recursive passes can't overflow the stack.

## Caching and invalidation

| Cache | Key / validator | Invalidated by |
|---|---|---|
| Ordered ids + aggregates of a query (server, LRU of 10) | table id, row data version, the fields' JSON, filter, sorts, time zone; plus a 15-minute bucket when the filter uses "today" | Any row write to the table (`markRowsChanged`), any field change. View saves don't invalidate it: they don't change results |
| Table schema (`GET /api/tables/:id`) | `ETag` = table version | Field changes and view saves (views are part of the response) |
| View (`PUT /api/views/:id`) | `If-Match` = view version | Each save; a stale version gets 412 with the current view |
| Client rows | the store's blocks | Query change (filter/sort), row deletes (reload), schema change (the grid remounts, keyed by a hash of the fields) |
| Import batches | `Idempotency-Key` = import id + batch number, stored with the result | Never; a repeated key returns the stored result |

The result cache and the data versions live on `globalThis`. Next.js bundles route handlers, pages and Server Actions separately, so module-level state would be one copy per bundle, and an import done by a Server Action would not invalidate what the rows endpoint reads.

## Forms

- **View panel.** One RHF form: the filter tree is nested `useFieldArray`s at a fixed depth of 2, sorts are a field array. It uses the same `viewQuerySchemaFor(fields)` as the server's save. Changing a condition's field replaces the whole condition (`defaultConditionFor`), and changing the operator keeps the value only if its shape fits (`changeOperator`), so no stale keys survive. Valid drafts reach the grid after a 300 ms debounce.
- **Field dialog.** RHF over the `Field` discriminated union with the shared field schema plus unique names. Changing the type resets the form to that type's defaults. Server errors land on the form fields they name.
- **Type change.** `lib/convert` turns each stored value into the new type: through text with the paste/import coercer (in the viewer's locale), except number ↔ currency, date ↔ date-time and select labels, which keep more than text would. `PATCH ?preview=1` runs it over every row and reports counts and examples. The real `PATCH` rewrites all rows in one transaction, removes view conditions the new type can't support, then recomputes dependent formulas.
- **Import.** Step 2 is a `useFieldArray` over the CSV columns, each a union (`skip | existing | new`). Step 3 builds a **zod object at runtime** from the mapping, one `string → value` transform per target field using the paste/editor coercer, and runs every row through it in chunks.

## Realtime and conflicts

- **Event log.** Every committed change is appended to an `events` table with a per-table sequence number: rows (with the cells written directly, plus creates and deletes), schema, view saves and bulk recomputes. Row writes and view saves log their event in the same transaction as the change.
- **Stream.** `GET /api/tables/:id/events` is SSE with the sequence number as the event id. The client keeps the last number it saw. A jump in the numbers, a heartbeat `tick` carrying a newer number, or a dropped connection makes it reconnect with `?since=<last>`, and the server replays the missing events from the log. If the log was pruned past that point, a `reset` tells the client to refetch instead. `REALTIME_DROP_RATE` drops live events to exercise this path.
- **Applying events.** A tab skips events caused by its own writes (`x-client-id`). Changed rows that are loaded are replaced in place, with this tab's unsent edits re-applied on top. Added or deleted rows shift positions, so the loaded windows are refetched in the background (coalesced, keeping the selection). A schema event refreshes the page, which remounts the grid; it explains when that closed the user's editor, field dialog or unsaved filter. A view event moves the saved baseline of the view panel.
- **Conflicts.** Writes are last-write-wins **per cell**: an op carries only the cells it changes, so edits of different cells of one row merge. Each tab remembers the value and row `rev` of its last confirmed write per cell. If an event later brings a newer `rev` with a different value in that cell, this tab lost: it shows a toast with both values and "Keep mine", which writes its value again.
- **Offline.** A batch that gets no answer, or a 5xx, stays queued in order with its edits still shown, and is resent with backoff (and at once on the browser's `online` event). The toolbar shows "Offline · N changes waiting". Only an answer that rejects an op rolls that op back.
- **Presence.** Each tab posts its active cell (debounced, plus a 20 s heartbeat). Presence is kept in memory per table, pushed on the same stream, and removed when the tab's stream closes. Others show as avatars and as a frame in their colour.

## Performance: how it was measured

Setup: Apple M1, Node 22, `next build && next start`, the 50 000-row seed, headless Chrome through `playwright-core`. Scripts: a `requestAnimationFrame` loop that scrolls the grid element, plus a `PerformanceObserver('longtask')`. Server timings were taken with curl. The laptop was on battery, where Chrome caps frames at 30 Hz, so per-frame work was measured with `--disable-frame-rate-limit --disable-gpu-vsync`.

- **Scroll.** Vertical 160 px/frame: frame time p50 3.8 / p95 5.2 / max 8.1 ms. Horizontal 40 px/frame: p95 4.8 / max 5.8 ms. 0 long tasks. About 42 row elements and 490 cells in the DOM.
- **Selection.** Arrow key → next frame: p50 3.1 / p95 7.6 ms. Only rows whose selection slice changes re-render.
- **Paste.** 10 000 cells (2 000 rows × 5 columns, 1 900 of them not loaded and fetched in 500-row pages): converted and announced in about 160 ms, 0 long tasks (conversion yields every 2 000 cells). It is sent as 2 batches of 1 000 ops.
- **SSR.** Warm grid page 15–45 ms, about 270 KB of HTML (100 rows × 30 columns of RSC payload). Cold (first query of a view) 150–310 ms.
- **Row windows.** First window of a query (filter + sort over 50 000 JSON rows): 110–260 ms. Later windows of the same query: 2–25 ms.
- **CSV import of 20 MB** (180 000 rows × 6 columns): parsed in the worker in 0.3 s, checked against the runtime schema in 1.4 s, imported in about 28 s (360 batches of 500 rows), 0 long tasks on the page.
- **Writes.** A 1 000-cell batch takes about 80 ms. One Customer edit that propagates to its Orders' lookups takes about 57 ms.

## Rejected alternatives

- **TanStack Table.** Sorting, filtering and grouping happen on the server, and the grid needs its own selection model. Only TanStack Virtual is used.
- **Cursor pagination.** Dragging the scrollbar must jump to row 40 000, so windows are fetched by offset. The cost: an edit that moves a row in the current sort, or a new row, can shift a row across a block boundary until the view reloads.
- **Keeping all rows on the client.** 50 000 × 30 cells is fine to hold, but filters, sorts and lookups need the server anyway, and the task asks for windows.
- **A SQL column per field.** Field create/delete/type change would mean `ALTER TABLE` per change. JSON plus `json_extract` keeps schema changes metadata-only, and the result cache absorbs the slower scans.
- **Temporal / date-fns-tz.** Wall time → instant in a zone, including DST gaps and overlaps, is about 30 lines on top of `Intl` (`lib/timezone.ts`).
