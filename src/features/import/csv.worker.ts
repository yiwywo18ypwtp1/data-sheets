/// <reference lib="webworker" />
import Papa from "papaparse";
import { detectEncoding, type TextEncoding } from "@/lib/import/encoding";

/**
 * Parses a CSV file off the main thread. The file is read and parsed in 1 MB chunks
 * (papaparse streaming), and rows are posted back per chunk, so neither parsing nor
 * receiving a 20 MB file blocks the page. The encoding is guessed from the first bytes
 * and the delimiter by papaparse; both can be forced when the guess is wrong.
 */

export type ParseRequest = { file: File; encoding?: TextEncoding; delimiter?: string };

export type ParseMessage =
  | { type: "rows"; rows: string[][]; progress: number }
  | { type: "done"; encoding: TextEncoding; delimiter: string }
  | { type: "error"; message: string };

const SAMPLE_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;

const post = (message: ParseMessage) => self.postMessage(message);

self.addEventListener("message", async (event: MessageEvent<ParseRequest>) => {
  const { file, delimiter } = event.data;
  try {
    const sample = new Uint8Array(await file.slice(0, SAMPLE_BYTES).arrayBuffer());
    const encoding = event.data.encoding ?? detectEncoding(sample).encoding;
    // Progress counts parsed characters; estimate the file's length in characters from the sample.
    const charsPerByte = sample.length > 0 ? new TextDecoder(encoding).decode(sample).length / sample.length : 1;
    const totalChars = Math.max(1, file.size * charsPerByte);
    let parsedChars = 0;
    let usedDelimiter = delimiter ?? ",";

    Papa.parse<string[]>(file, {
      encoding, // FileReader decoding; a BOM is recognised and dropped by it
      delimiter: delimiter ?? "",
      delimitersToGuess: [",", ";", "\t", "|"],
      skipEmptyLines: "greedy",
      chunkSize: CHUNK_BYTES,
      chunk(results) {
        parsedChars += results.meta.cursor;
        usedDelimiter = results.meta.delimiter;
        post({ type: "rows", rows: results.data, progress: Math.min(0.99, parsedChars / totalChars) });
      },
      complete() {
        post({ type: "done", encoding, delimiter: usedDelimiter });
      },
      error(error) {
        post({ type: "error", message: error.message });
      },
    });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : "Couldn't read the file" });
  }
});
