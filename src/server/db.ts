import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { seedDatabase } from "./seed";

export type Db = Database.Database;

/**
 * Fields and views are JSON columns on their table: they're always read and
 * written as a whole with the table schema. Row values are a JSON object per row,
 * filtered and sorted with `json_extract` (see filterSql.ts).
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL REFERENCES bases(id),
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    primary_field_id TEXT NOT NULL,
    fields TEXT NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS views (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    position INTEGER NOT NULL,
    config TEXT NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rows (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    seq INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cells TEXT NOT NULL,
    errors TEXT
  );
  CREATE INDEX IF NOT EXISTS rows_by_table ON rows(table_id, seq);
  CREATE TABLE IF NOT EXISTS events (
    table_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (table_id, seq)
  );
  CREATE TABLE IF NOT EXISTS form_submissions (
    key TEXT PRIMARY KEY,
    view_id TEXT NOT NULL,
    row_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cell_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    field_id TEXT NOT NULL,
    before TEXT,
    after TEXT,
    rev INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cell_history_by_row ON cell_history(row_id, id);
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_by_row ON comments(row_id, created_at);
  CREATE TABLE IF NOT EXISTS mentions (
    comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    read_at TEXT,
    PRIMARY KEY (comment_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS mentions_by_user ON mentions(user_id);
  CREATE TABLE IF NOT EXISTS import_batches (
    key TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

function openDatabase(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // SQLite's lower() only folds ASCII; filters must be case-insensitive for "Київ" too.
  db.function("ulower", { deterministic: true }, (value: unknown) =>
    value === null ? null : String(value).toLowerCase(),
  );
  db.exec(SCHEMA);
  seedDatabase(db, Number(process.env.SEED_SCALE ?? 1));
  return db;
}

// Survives Next.js dev hot reloads, which re-evaluate this module.
const globalForDb = globalThis as unknown as { db?: Db };

/** The single shared connection. better-sqlite3 is synchronous, so there is no pool. */
export function getDb(): Db {
  globalForDb.db ??= openDatabase(process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "data-sheets.db"));
  return globalForDb.db;
}
