import { z } from "zod";

/**
 * Ids end up inside formula references (`{fld_abc}`) and SQLite JSON paths
 * (`$.fld_abc`), so they are restricted to a safe character set.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid id");

type IdPrefix = "tbl" | "fld" | "viw" | "row" | "opt" | "usr";

/** Ids are generated on the client too, so optimistic rows and fields keep their id after the server confirms them. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
