import type { ClipboardEvent } from "react";
import { createCoercer } from "@/lib/coerce/coerce";
import { isComputedField, type Field } from "@/lib/domain/field";
import { toEditText, type CellFormatter } from "@/lib/format";
import type { CellError, GridStore } from "./GridStore";
import type { HistoryChange } from "./history";
import type { GridColumn } from "./layout";
import type { DisplayRow } from "./optimistic";
import { planPaste } from "./paste";
import { rangeOf } from "./selection";
import { parseTsv, toTsv } from "./tsv";

type Options = {
  store: GridStore;
  columns: GridColumn[];
  canEdit: boolean;
  locale: string;
  timeZone: string;
  formatters: Map<string, CellFormatter>;
};

/** Converting cells yields to the browser this often, so a 10 000-cell paste never blocks the UI for long. */
const CELLS_PER_CHUNK = 2000;
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/**
 * Copy as TSV and paste from Excel / Google Sheets.
 *
 * Copied text is what the cell editor would show (numbers without grouping, numeric
 * dates), so it pastes back into this grid or a spreadsheet unchanged. Pasted text is
 * converted per column with the same coercer as the editors. Cells that can't be
 * converted keep their value and are highlighted with the reason; they're never
 * silently emptied. One paste is one undo step.
 */
export function useClipboard({ store, columns, canEdit, locale, timeZone, formatters }: Options) {
  function copyText(field: Field, row: DisplayRow): string {
    const error = row.errors?.[field.id];
    if (error) return error.split(" ")[0];
    const value = row.values[field.id];
    // Computed values can't be pasted back anyway; copy what's displayed.
    if (isComputedField(field)) return formatters.get(field.id)?.(value) ?? "";
    return toEditText(field, value, { locale, timeZone, labelOf: store.getLabel });
  }

  function toClipboardText(rows: DisplayRow[], left: number, right: number): string {
    return toTsv(rows.map((row) => columns.slice(left, right + 1).map((column) => copyText(column.field, row))));
  }

  function onCopy(event: ClipboardEvent<HTMLElement>) {
    const selection = store.selection;
    if (!selection || store.editing) return;
    event.preventDefault();
    const { top, bottom, left, right } = rangeOf(selection);
    const cells = (bottom - top + 1) * (right - left + 1);

    const loaded: DisplayRow[] = [];
    for (let index = top; index <= bottom; index++) {
      const row = store.getRowAt(index);
      if (!row) break;
      loaded.push(row);
    }
    if (loaded.length === bottom - top + 1) {
      event.clipboardData.setData("text/plain", toClipboardText(loaded, left, right));
      store.announce(`Copied ${plural(cells, "cell")}`);
      return;
    }
    // Some rows aren't in memory: load them, then use the async clipboard API.
    store.announce("Copying…");
    store
      .getRowsInRange(top, bottom)
      .then((rows) => navigator.clipboard.writeText(toClipboardText(rows, left, right)))
      .then(() => store.announce(`Copied ${plural(cells, "cell")}`))
      .catch(() => store.announce("Couldn't copy the selection"));
  }

  function onPaste(event: ClipboardEvent<HTMLElement>) {
    if (store.editing) return; // the editor's input handles its own paste
    event.preventDefault();
    if (!canEdit) return store.announce("You have view-only access to this table");
    void paste(event.clipboardData.getData("text/plain"));
  }

  async function paste(text: string) {
    const selection = store.selection;
    const plan = selection ? planPaste(parseTsv(text), rangeOf(selection), { rows: store.total, cols: columns.length }) : null;
    if (!plan) return;

    let rowCount = plan.rows;
    if (plan.extraRows > 0) {
      const choice = await store.askAboutExtraRows(plan.extraRows);
      if (choice === "cancel") return;
      if (choice === "fit") rowCount -= plan.extraRows;
    }

    store.announce("Pasting…");
    const existing = Math.min(rowCount, store.total - plan.top);
    let rows: DisplayRow[];
    try {
      rows = existing > 0 ? await store.getRowsInRange(plan.top, plan.top + existing - 1) : [];
    } catch {
      return store.announce("Paste cancelled: the view changed");
    }
    while (rows.length < rowCount) rows.push(store.getRowAt(store.addRow())!);

    // One coercer per column (they prepare Intl formatters); null for computed fields, which are skipped.
    const targets = columns.slice(plan.left, plan.left + plan.cols).map((column) => ({
      field: column.field,
      coerce: isComputedField(column.field) ? null : createCoercer(column.field, { locale, timeZone }),
    }));

    const changes: HistoryChange[] = [];
    const errors: CellError[] = [];
    let skipped = 0;
    let processed = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < targets.length; c++) {
        const { field, coerce } = targets[c];
        if (!coerce) {
          skipped++;
          continue;
        }
        const source = plan.textAt(r, c);
        const result = coerce(source);
        if (!result.ok) {
          errors.push({ rowId: row.id, fieldId: field.id, message: `Couldn't paste "${source.slice(0, 40)}": ${result.error}` });
        } else if (!sameValue(row.values[field.id], result.value)) {
          changes.push({ rowId: row.id, fieldId: field.id, before: row.values[field.id] ?? null, after: result.value, row: plan.top + r, col: plan.left + c });
        }
      }
      processed += targets.length;
      if (processed >= CELLS_PER_CHUNK) {
        processed = 0;
        await yieldToBrowser();
      }
    }

    store.applyChanges(`paste of ${plural(changes.length, "cell")}`, changes);
    store.setCellErrors(errors);
    store.setSelection({
      anchor: { row: plan.top, col: plan.left },
      focus: { row: plan.top + rows.length - 1, col: plan.left + targets.length - 1 },
    });
    const parts = [`Pasted ${plural(changes.length, "cell")}`];
    if (errors.length > 0) parts.push(`${plural(errors.length, "cell")} couldn't be converted and are highlighted`);
    if (skipped > 0) parts.push(`${plural(skipped, "computed cell")} skipped`);
    store.announce(parts.join("; "));
  }

  return { onCopy, onPaste, paste };
}
