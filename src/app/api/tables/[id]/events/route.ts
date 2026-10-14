import { idSchema } from "@/lib/domain/ids";
import { errorResponse } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { eventsSince, latestSeq, listPresence, onPresence, onTableEvents, removePresence } from "@/server/events";
import { getTable } from "@/server/tables";

/** Also how long a lost last event can go unnoticed: the heartbeat carries the latest number. */
const HEARTBEAT_MS = 5_000;

/**
 * Server-Sent Events: the table's changes, each with its sequence number as the SSE `id`.
 * `?since=N` (or the browser's automatic `Last-Event-ID` on reconnect) replays what was
 * missed from the event log first; without it the stream starts at "now". If the log no
 * longer reaches back that far, a `reset` event tells the client to reload instead.
 *
 * REALTIME_DROP_RATE drops that share of live events (never replays), to exercise the
 * client's gap detection: it sees a jump in the numbers (or a heartbeat `tick` with a
 * number it hasn't received) and reconnects with `since`.
 * Presence of other tabs is pushed as `presence` events; it lives as long as the stream.
 */
export async function GET(request: Request, context: RouteContext<"/api/tables/[id]/events">) {
  try {
    await getCurrentUser();
    const table = getTable((await context.params).id);
    if (!table) throw notFound("Table");
    const url = new URL(request.url);
    const sinceParam = url.searchParams.get("since") ?? request.headers.get("last-event-id");
    const since = sinceParam !== null && /^\d+$/.test(sinceParam) ? Number(sinceParam) : latestSeq(table.id);
    const clientId = idSchema.safeParse(url.searchParams.get("clientId")).data ?? null;
    const dropRate = Number(process.env.REALTIME_DROP_RATE ?? 0);
    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let last = since;
        let closed = false;
        const send = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const pump = (live: boolean) => {
          for (;;) {
            const { events, gap } = eventsSince(table.id, last);
            if (gap) {
              last = events.at(-1)!.seq;
              send(`id: ${last}\nevent: reset\ndata: {}\n\n`);
              continue;
            }
            for (const event of events) {
              last = event.seq;
              if (live && dropRate > 0 && Math.random() < dropRate) continue;
              send(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
            }
            if (events.length === 0) return;
          }
        };
        const sendPresence = () => send(`event: presence\ndata: ${JSON.stringify(listPresence(table.id))}\n\n`);

        send(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ since })}\n\n`);
        // A number from the future: the log was reset (`npm run db:reset`). Start over.
        if (since > latestSeq(table.id)) {
          last = latestSeq(table.id);
          send(`id: ${last}\nevent: reset\ndata: {}\n\n`);
        }
        pump(false);
        sendPresence();
        const offEvents = onTableEvents(table.id, () => pump(true));
        const offPresence = onPresence(table.id, sendPresence);
        // A lost event is noticed when a later one arrives; if it was the last one, the
        // heartbeat's number shows the client it's behind.
        const heartbeat = setInterval(() => send(`event: tick\ndata: ${JSON.stringify({ seq: last })}\n\n`), HEARTBEAT_MS);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          offEvents();
          offPresence();
          if (clientId) removePresence(table.id, clientId);
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        };
        request.signal.addEventListener("abort", () => cleanup());
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        // no-transform: keeps `next start`'s compression from buffering the stream.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
