/**
 * Guesses a CSV file's text encoding from its first bytes. Exports from Excel in
 * Ukrainian/Russian Windows are typically Windows-1251, everything modern is UTF-8,
 * and Excel's "Unicode text" is UTF-16 with a BOM.
 */

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1251";

export const ENCODINGS: TextEncoding[] = ["utf-8", "windows-1251", "utf-16le", "utf-16be"];

/** How many leading bytes are a byte order mark for `encoding` (to be skipped). */
export type EncodingGuess = { encoding: TextEncoding; bomLength: number };

/** A multi-byte UTF-8 character cut off at the end of the sample isn't an error. */
function withoutTrailingPartialChar(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation byte: keep looking for the lead byte
    const length = byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1;
    return length > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

export function detectEncoding(sample: Uint8Array): EncodingGuess {
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return { encoding: "utf-8", bomLength: 3 };
  if (sample[0] === 0xff && sample[1] === 0xfe) return { encoding: "utf-16le", bomLength: 2 };
  if (sample[0] === 0xfe && sample[1] === 0xff) return { encoding: "utf-16be", bomLength: 2 };
  try {
    // Valid UTF-8 is very unlikely to be anything else: 1251 text with Cyrillic is never valid UTF-8.
    new TextDecoder("utf-8", { fatal: true }).decode(withoutTrailingPartialChar(sample));
    return { encoding: "utf-8", bomLength: 0 };
  } catch {
    return { encoding: "windows-1251", bomLength: 0 };
  }
}
