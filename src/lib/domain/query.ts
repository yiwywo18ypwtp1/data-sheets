import { filterGroupSchema, type FilterGroup } from "./filter";
import { sortsSchema, type Sort } from "./view";

/**
 * Filter and sort travel in query strings (`/rows?filter=…&sort=…`). The filter is
 * JSON in URL-safe base64 (it's a tree); sorts are readable: `fld_a:asc,fld_b:desc`.
 * Decoders return null for anything malformed, so `?filter=garbage` is a clean 400.
 */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function encodeFilterParam(filter: FilterGroup): string {
  return toBase64Url(JSON.stringify(filter));
}

export function decodeFilterParam(encoded: string): FilterGroup | null {
  const json = fromBase64Url(encoded);
  if (json === null) return null;
  try {
    const parsed = filterGroupSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeSortParam(sorts: Sort[]): string {
  return sorts.map((sort) => `${sort.fieldId}:${sort.direction}`).join(",");
}

export function decodeSortParam(encoded: string): Sort[] | null {
  if (encoded === "") return [];
  const sorts = encoded.split(",").map((part) => {
    const [fieldId, direction] = part.split(":");
    return { fieldId, direction };
  });
  const parsed = sortsSchema.safeParse(sorts);
  return parsed.success ? parsed.data : null;
}
