import type { TextEncoding } from "@/lib/import/encoding";
import type { ParseMessage, ParseRequest } from "./csv.worker";

/** A parsed CSV: the first row is the header. Rows are kept in a plain array, never in React state. */
export type ParsedCsv = {
  /** Kept to save an interrupted import (the file goes into IndexedDB) and to parse it again. */
  file: File;
  fileName: string;
  encoding: TextEncoding;
  delimiter: string;
  headers: string[];
  rows: string[][];
};

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Header names, never empty, padded to the widest row. */
function headersOf(first: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => first[i]?.trim() || `Column ${i + 1}`);
}

/**
 * Parses a CSV file in a Web Worker (see csv.worker.ts), reporting progress. Returns a
 * cancel function; `done` gets the parsed file or an error message.
 */
export function parseCsvFile(
  file: File,
  options: Omit<ParseRequest, "file">,
  onProgress: (progress: number, rows: number) => void,
  done: (result: { ok: true; csv: ParsedCsv } | { ok: false; error: string }) => void,
): () => void {
  if (file.size > MAX_FILE_BYTES) {
    done({ ok: false, error: `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB.` });
    return () => {};
  }
  const worker = new Worker(new URL("./csv.worker.ts", import.meta.url), { type: "module" });
  const all: string[][] = [];
  worker.onmessage = (event: MessageEvent<ParseMessage>) => {
    const message = event.data;
    if (message.type === "rows") {
      for (const row of message.rows) all.push(row);
      onProgress(message.progress, all.length);
      return;
    }
    worker.terminate();
    if (message.type === "error") return done({ ok: false, error: `Couldn't read the file: ${message.message}` });
    if (all.length < 2) return done({ ok: false, error: "The file has no data rows: the first row must be the column headers." });
    const width = Math.max(...all.slice(0, 1000).map((row) => row.length));
    done({ ok: true, csv: { file, fileName: file.name, encoding: message.encoding, delimiter: message.delimiter, headers: headersOf(all[0], width), rows: all.slice(1) } });
  };
  worker.postMessage({ file, ...options } satisfies ParseRequest);
  return () => worker.terminate();
}
