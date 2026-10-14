import "server-only";
import { revalidateTag } from "next/cache";

/**
 * Cache tags of public forms (`/f/[viewId]` caches the form's definition): the view's own
 * settings, and the fields of its table. Expired at once ({ expire: 0 }): a guest must not
 * get a form whose questions no longer match the table.
 */
export const formTags = {
  view: (viewId: string) => `form-view:${viewId}`,
  table: (tableId: string) => `form-table:${tableId}`,
};

export function expireFormCache(tag: string): void {
  try {
    revalidateTag(tag, { expire: 0 });
  } catch {
    // Outside a Next.js request (tests, the seed) there's no cache to expire.
  }
}
