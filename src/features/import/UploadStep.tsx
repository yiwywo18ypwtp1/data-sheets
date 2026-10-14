import { useEffect, useRef, useState } from "react";
import { ENCODINGS, type TextEncoding } from "@/lib/import/encoding";
import type { ParseMessage, ParseRequest } from "./csv.worker";
import { buttonClass, primaryButtonClass, selectClass } from "./styles";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PREVIEW_ROWS = 50;

/** A parsed CSV: the first row is the header. Rows are kept in a plain array, never in React state. */
export type ParsedCsv = {
  fileName: string;
  encoding: TextEncoding;
  delimiter: string;
  headers: string[];
  rows: string[][];
};

const DELIMITERS: Record<string, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" };

type Parsing = { progress: number; rows: number };

/** Header names, never empty, padded to the widest row. */
function headersOf(first: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => first[i]?.trim() || `Column ${i + 1}`);
}

/**
 * Step 1: pick a file, parse it in a Web Worker with progress, show what was detected
 * (encoding, delimiter; both can be overridden, which parses again) and the first 50 rows.
 */
export function UploadStep({ parsed, onParsed, onNext }: { parsed: ParsedCsv | null; onParsed: (csv: ParsedCsv | null) => void; onNext: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState<Parsing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  function parse(source: File, options: Omit<ParseRequest, "file"> = {}) {
    workerRef.current?.terminate();
    setError(null);
    onParsed(null);
    if (source.size > MAX_FILE_BYTES) return setError(`The file is ${(source.size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB.`);

    const worker = new Worker(new URL("./csv.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const all: string[][] = [];
    setParsing({ progress: 0, rows: 0 });
    worker.onmessage = (event: MessageEvent<ParseMessage>) => {
      const message = event.data;
      if (message.type === "rows") {
        for (const row of message.rows) all.push(row);
        setParsing({ progress: message.progress, rows: all.length });
      } else if (message.type === "error") {
        worker.terminate();
        setParsing(null);
        setError(`Couldn't read the file: ${message.message}`);
      } else {
        worker.terminate();
        setParsing(null);
        if (all.length < 2) return setError("The file has no data rows: the first row must be the column headers.");
        const width = Math.max(...all.slice(0, 1000).map((row) => row.length));
        onParsed({ fileName: source.name, encoding: message.encoding, delimiter: message.delimiter, headers: headersOf(all[0], width), rows: all.slice(1) });
      }
    };
    worker.postMessage({ file: source, ...options } satisfies ParseRequest);
  }

  function cancel() {
    workerRef.current?.terminate();
    setParsing(null);
  }

  return (
    <section aria-labelledby="upload-title" className="flex min-h-0 flex-col gap-3">
      <h2 id="upload-title" className="font-semibold">
        1. Choose a CSV file
      </h2>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          aria-label="CSV file"
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            if (chosen) parse(chosen);
          }}
        />
        <span className="text-zinc-500">Up to 20 MB. The first row must contain the column names.</span>
      </div>

      {parsing && (
        <div className="flex items-center gap-3 text-sm">
          <progress aria-label="Reading the file" value={parsing.progress} max={1} className="w-64" />
          <span>{parsing.rows.toLocaleString()} rows read…</span>
          <button type="button" className={buttonClass} onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {parsed && file && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span>
              <strong>{parsed.rows.length.toLocaleString()}</strong> rows · {parsed.headers.length} columns
            </span>
            <label className="flex items-center gap-1.5">
              Encoding
              <select className={selectClass} value={parsed.encoding} onChange={(event) => parse(file, { encoding: event.target.value as TextEncoding, delimiter: parsed.delimiter })}>
                {ENCODINGS.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              Delimiter
              <select className={selectClass} value={parsed.delimiter} onChange={(event) => parse(file, { encoding: parsed.encoding, delimiter: event.target.value })}>
                {Object.entries(DELIMITERS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={`${primaryButtonClass} ml-auto`} onClick={onNext}>
              Next: map columns
            </button>
          </div>
          <PreviewTable headers={parsed.headers} rows={parsed.rows.slice(0, PREVIEW_ROWS)} caption={`First ${Math.min(PREVIEW_ROWS, parsed.rows.length)} rows`} />
        </>
      )}
    </section>
  );
}

export function PreviewTable({ headers, rows, caption }: { headers: string[]; rows: string[][]; caption: string }) {
  return (
    <div className="min-h-0 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
      <table className="text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th className="px-2 py-1 text-right font-normal text-zinc-400">#</th>
            {headers.map((header, i) => (
              <th key={i} scope="col" className="max-w-56 truncate px-2 py-1 text-left font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-2 py-0.5 text-right text-zinc-400">{r + 1}</td>
              {headers.map((_, c) => (
                <td key={c} className="max-w-56 truncate px-2 py-0.5">
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
