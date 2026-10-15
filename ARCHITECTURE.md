# Architecture

Next.js 16 App Router (`cacheComponents`), React 19, SQLite via `better-sqlite3`. One Node process serves pages, Route Handlers (the mock API) and Server Actions.

## Server / client split

| Part | Where | Why |
|---|---|---|
| Layout, tabs, role badge | Server Components | Static markup; read the DB and the user cookie directly |
| Grid page shell + **first 100 rows** | Server | The grid paints with data, without a client round trip |
| Grid, selection, editors, clipboard, undo | Client | Pointer and keyboard work at 60 fps |
| View panel, field dialog, formula editor, form builder | Client (React Hook Form) | Live validation and previews |
| CSV import | Client + Web Worker; batches go to a **Server Action** | Parsing 20 MB must not block the page |
| Public form `/f/[viewId]` | Static shell + `use cache` definition; submit is a **Server Action** | Guests get a cached page; answers are validated in the browser and on the server with the same runtime schema |
| `/api/...` | Route Handlers | The task's REST contract, one error format (`server/api.ts`) |
| Id checks for `/b/…`, `/f/…` | `src/proxy.ts` | Pages stream, so a `notFound()` inside one would answer 200; the proxy gives real 404s and 307s |

`lib/` is isomorphic: zod schemas, the formula engine, value coercion, import mapping and type conversion. The editors, paste, import, forms and the server validate with the same code.

## Storage

`tables.fields` and `views.config` are JSON columns (always read and written whole). A row is one JSON object of cells keyed by field id, plus `rev`, `seq` (creation order) and formula errors. Filters and sorts compile to `json_extract` SQL with every value and JSON path bound. Values are locale-neutral (numbers, `YYYY-MM-DD`, UTC ISO date-times, option ids); only display is localized.

## Client grid state

`GridStore` is a plain class read with `useSyncExternalStore`: each row subscribes to its own row, selection slice and editing column, so a window load or a selection move re-renders only the rows involved. Without React inside, it's unit-tested directly; Zustand would wrap the same hook.

- **Windows and memory.** Blocks of 100 rows for the visible range plus overscan, loaded after 50 ms of scroll quiet, aborted when scrolled away, dropped if they answer an older query. At most 12 blocks stay; the furthest are evicted (rows with unsaved edits stay until the server answers).
- **Writes.** Optimistic; everything written in one tick (a whole paste) is one batch; batches go out one at a time, so the server sees the user's order. A rejected op rolls back only its cells, which get a red frame with the reason. A batch that gets no answer (offline, 5xx) stays queued, edits still shown, and is resent with backoff.
- **Undo.** One user action (edit, clear, fill, a 10 000-cell paste, a deletion) is one history entry with `before`/`after` per cell (deleted records are recreated with their id and creation time). Undo scrolls to what it changed, from anywhere in the table.
- **Grouping.** The server orders by the group fields first and returns each group's start, count and sums, computed in the same pass as the ordered ids and cached with them. `GroupLayout` maps screen rows (headers, rows of expanded groups) to result positions as segments, with binary search both ways; only the virtualizer deals in screen rows.
- **Saving views.** The column layout (immediately) and the panel's filter/sort/grouping (on Save) go through one queue with `If-Match`; on a 412 the patch is re-applied to the newer version.

## Formulas

Lexer → Pratt parser → type checker → evaluator, each reporting errors with a position (`Unknown field "Prise" at 8`). Expressions are stored with field ids (`{fld_x}`), so renames break nothing; a deleted reference evaluates to `#REF!`. Runtime errors are values that propagate. Results are normalised to the declared type (no float noise, so a filter `= 4680.65` matches). The dependency graph has edges from formula references and from lookups to their link and target fields across tables; a cycle is refused on save with its path. A cell write recomputes only its dependents in topological order, then propagates through lookups to linking rows of other tables, once per batch. The client recomputes same-row formulas optimistically with the same engine. Formulas are limited to 10 000 characters and 512 levels of nesting (brackets, arguments, prefix operators). An operator chain `1+1+…` is a left-deep tree, so the checker and evaluator walk its left spine in a loop and it costs no nesting. Function arguments are checked by kind on save (`SUM({Qty}, "a")` is refused; a text *field* passes because its value is only known per row). Formula results are stored, so a formula that calls `TODAY()` is marked volatile at compile time; the first read of a base each UTC day recomputes the volatile formulas and what depends on them (only rows whose result changed are written, with no new revision), and open grids get a `reload` event.

## Caching and invalidation

| Cache | Key / validator | Invalidated by |
|---|---|---|
| Ordered ids + aggregates + groups of a query (server LRU of 10) | table, row data version, fields JSON, filter, sorts, groups, time zone (+ 15-min bucket for "today" filters) | Row writes, field changes; not view saves |
| Table schema (`GET /api/tables/:id`) | `ETag` = table version | Field changes, view saves |
| View (`PUT /api/views/:id`) | `If-Match` = view version | Each save (stale → 412 with the current view) |
| Client rows | the store's blocks | Query change, deletes, remote changes (background refetch), schema change (grid remounts) |
| Public form definition (`use cache`) | tags `form-view:<id>`, `form-table:<id>` | View save, field change: `revalidateTag(tag, { expire: 0 })`, so no guest gets a stale form |
| Import batches, form submissions | idempotency key (import id + batch number; submission id) | Never: a repeat returns the stored result |

Server-side shared state (DB, result cache, realtime bus, rate limits) lives on `globalThis`: Next.js bundles route handlers, pages and Server Actions separately, and module state would be one copy per bundle (an import via a Server Action wouldn't invalidate the rows endpoint's cache).

## Forms

- **View panel.** One RHF form: the filter tree is nested `useFieldArray`s at a fixed depth of 2; sorts and groups are field arrays. Same `viewQuerySchemaFor(fields)` as the server's save. Changing a condition's field replaces it whole, changing the operator keeps only a value of the same shape, so no stale keys survive. Valid drafts reach the grid after 300 ms; an unsaved filter is mirrored into `?filter=` for sharing.
- **Fields.** RHF over the `Field` discriminated union; a type change resets to that type's defaults. Converting stored values (`lib/convert`) goes through text with the paste coercer in the viewer's locale, except number ↔ currency, date ↔ date-time and select labels. `PATCH ?preview=1` reports counts and examples over every row; the real `PATCH` rewrites all rows in one transaction and drops view conditions the new type can't support.
- **Import.** A `useFieldArray` over CSV columns (`skip | existing | new`), then a **zod object built at runtime** from the mapping, one `string → value` transform per target. Link columns match the linked table's primary value; missing records can be created first with ids chosen up front. The session (file, choices, progress) is saved in IndexedDB after every batch, so a closed tab resumes, and batch keys make the overlap safe.
- **Public form.** The answers' schema is built at runtime from the questions (order, required, conditional visibility) and the fields' types, on the page and in the action. A submit carries a submission id (one record per fill), the form version (a schema change while filling is refused with an explanation and the form reloads, keeping answers), a honeypot field, and a rate limit: 5 per minute per client and 60 per form. "Client" is the `X-Forwarded-For` entry a trusted proxy appended (`TRUSTED_PROXY_HOPS`); the header is otherwise client-written and ignored. Counters are swept once a minute and capped at 10 000 keys.

## Realtime and conflicts

- **Log and stream.** Every committed change (rows with the cells written directly, creates, deletes; schema; view saves) is appended to an `events` table with a per-table sequence, in the same transaction for rows and views. `GET /api/tables/:id/events` is SSE with that number as the event id. A gap in the numbers, a heartbeat `tick` with a newer number, or a dropped connection makes the client reconnect with `?since=<last>`; the server replays from the log (or sends `reset` if pruned). `REALTIME_DROP_RATE` exercises this.
- **Applying.** A tab skips its own events (`x-client-id`). Loaded rows are replaced in place with the tab's unsent edits on top; added or deleted rows trigger a background refetch of the loaded windows. A deleted row closes its open editor; a schema change remounts the grid and says what it closed.
- **Conflicts.** Last write wins **per cell**: ops carry only changed cells, so different cells of one row merge. Each tab remembers the value and `rev` of its last confirmed write per cell; an event with a newer `rev` and another value there means this tab lost, and it shows a toast with both values and "Keep mine".
- **Presence.** Tabs post their active cell (debounced + heartbeat); it's kept in memory and pushed on the stream, shown as avatars and coloured frames.

## Performance: how it was measured

Apple M1, Node 22, `next build && next start`, 50 000-row seed, headless Chrome via `playwright-core`: a `requestAnimationFrame` loop scrolling the grid plus `PerformanceObserver('longtask')`; server timings with curl. On battery Chrome caps frames at 30 Hz, so frame work was measured with `--disable-frame-rate-limit --disable-gpu-vsync`.

- **Scroll:** vertical 160 px/frame p50 3.8 / p95 5.2 / max 8.1 ms; horizontal p95 4.8 ms; grouped (two levels) p95 5.6 ms; 0 long tasks; ~42 rows and ~490 cells in the DOM.
- **Selection:** arrow key → next frame p50 3.1 / p95 7.6 ms.
- **Paste:** 10 000 cells (1 900 rows not loaded) converted and announced in ~160 ms, 0 long tasks; sent as 2 batches.
- **SSR:** warm grid page 15–45 ms, ~270 KB; cold (first query of a view) 150–310 ms.
- **Row windows:** first window of a query 110–260 ms; next windows 2–25 ms.
- **Writes:** 1 000-cell batch ~80 ms; a Customer edit propagating to its Orders ~57 ms; converting a field's 500 values ~0.8 s round trip.
- **Import of 20 MB** (180 000 rows): parse 0.3 s, check 1.4 s, import ~28 s, 0 long tasks.

## Tests

Vitest: pure logic and the API through its route handlers against an in-memory seed, in two time zones; React Testing Library: grid keyboard and editing, the filter tree, import mapping; Playwright (production build, fresh DB): saved view after reload, paste with one-step undo/redo, import with fixed and skipped errors, two tabs merging and conflicting.

## Rejected alternatives

- **TanStack Table:** sorting, filtering and grouping are server-side, and the selection model is the grid's own; only TanStack Virtual is used.
- **Cursor pagination:** dragging the scrollbar must jump to row 40 000, so windows are by offset. The cost: an edit that moves a row in the sort can shift a row across a block boundary until the windows reload.
- **A SQL column per field:** every field change would be an `ALTER TABLE`; JSON keeps schema changes metadata-only, and the result cache absorbs slower scans.
- **Temporal / date-fns-tz:** wall time → instant with DST gaps and overlaps is ~30 lines on `Intl` (`lib/timezone.ts`).
- **WebSocket:** updates flow one way; SSE plus plain POSTs is simpler, reconnects by itself, and carries event ids natively.
