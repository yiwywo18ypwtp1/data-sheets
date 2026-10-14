import { visibleFields } from "@/lib/domain/view";
import { createExportFormatter, csvLine, guardFormula, UTF8_BOM } from "@/lib/export/csv";
import { apiRoute, parseSearchParams } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { now } from "@/server/clock";
import { notFound } from "@/server/errors";
import { resolveRowQuery, rowQueryParamsSchema } from "@/server/rowQuery";
import { getRowsByIds, linkedRecordLabels, queryRowIds } from "@/server/rows";
import { getTable } from "@/server/tables";

/** Rows read and written per pull: small enough that the event loop stays responsive between chunks. */
const CHUNK_ROWS = 500;

/** `Content-Disposition` with a UTF-8 file name ("Замовлення.csv") and an ASCII fallback. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The rows of a view (or of an unsaved filter/sort, same parameters as `GET /rows`) as
 * CSV, streamed: the ordered ids are taken once (a consistent snapshot, from the result
 * cache), then rows are read, formatted and sent 500 at a time as the client pulls them.
 * Memory stays flat for 50 000 rows, the download starts at once, and a cancelled
 * download stops the reading. Columns are the view's visible fields in its order.
 */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/export">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const query = resolveRowQuery(table, parseSearchParams(request, rowQueryParamsSchema));
  const fields = query.view ? visibleFields(table.fields, table.primaryFieldId, query.view) : table.fields;
  const ids = queryRowIds(table, { filter: query.filter, sorts: query.sorts, groupBy: query.groupBy, context: { now: now(), timeZone: query.timeZone } });
  const primaryFieldOf = (tableId: string) => getTable(tableId)?.primaryFieldId ?? null;

  // Built once (Intl formatters are slow to create); link labels are looked up per chunk.
  let labels: Record<string, string> = {};
  const formatters = fields.map((field) => createExportFormatter(field, { timeZone: query.timeZone, labelOf: (id) => labels[id] }));
  const encoder = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(UTF8_BOM + csvLine(fields.map((field) => guardFormula(field.name)))));
    },
    pull(controller) {
      if (offset >= ids.length) return controller.close();
      // Rows deleted since the snapshot are skipped; edited ones are exported as they are now.
      const rows = getRowsByIds(table.id, ids.slice(offset, offset + CHUNK_ROWS));
      offset += CHUNK_ROWS;
      labels = linkedRecordLabels(fields, rows, primaryFieldOf);
      let text = "";
      for (const row of rows) text += csvLine(fields.map((field, i) => formatters[i](row.values[field.id], row.errors?.[field.id])));
      controller.enqueue(encoder.encode(text));
    },
  });

  const name = `${table.name}${query.view ? ` - ${query.view.name}` : ""}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": attachment(name),
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      // Known before the body: the client can show progress in rows.
      "X-Total-Rows": String(ids.length),
    },
  });
});
