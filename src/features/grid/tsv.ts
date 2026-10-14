/**
 * Tab-separated text as Excel and Google Sheets put on the clipboard. A value that
 * contains a tab, a line break or a quote is wrapped in quotes, with quotes doubled.
 */

function quote(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toTsv(rows: string[][]): string {
  return rows.map((row) => row.map(quote).join("\t")).join("\n");
}

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (char === '"' && value === "") {
      // Quoted value: runs until a quote that isn't doubled.
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          value += text[i++];
        }
      }
      continue;
    }
    if (char === "\t") {
      row.push(value);
      value = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
    i++;
  }
  // Sheets end the copied text with a line break; that doesn't add an empty row.
  if (value !== "" || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}
