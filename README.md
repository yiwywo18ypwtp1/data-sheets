# Data Sheets

A simplified Airtable built with Next.js App Router. The task statement is in [frontend-task-data-sheets.md](frontend-task-data-sheets.md).

## Requirements

- Node.js 22 (see `.nvmrc`; run `nvm use`)

## Scripts

```bash
npm install
npm run dev        # start the dev server
npm test           # run unit tests (Vitest)
npm run test:tz    # run unit tests in Pacific/Auckland and America/Los_Angeles
npm run typecheck  # tsc --noEmit
npm run lint
npm run db:reset   # delete the local SQLite database; it is re-created and re-seeded on the next request
```

## Data

The app uses a local SQLite database at `data/data-sheets.db` (override with `DATABASE_PATH`).
On first use it is seeded with deterministic demo data: Orders (50 000 rows × 30 fields),
Customers (5 000) and Products (500), linked to each other, with 5 formulas, 2 lookups and
3 views per table. `SEED_SCALE=0.1` seeds a tenth of the rows for quicker local runs.

Users (switch on `/settings`): Cora Creator (creator, the default), Eddie Editor (editor), Vera Viewer (viewer).

Full setup, env variables and manual check instructions will be added as features land.
