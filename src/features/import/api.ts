import { request } from "@/features/grid/api";

const CHUNK = 20_000;

/** Records of a table by primary value (see /records/match), for link columns. Keys are the labels as sent. */
export async function matchRecords(tableId: string, labels: string[]): Promise<Record<string, string>> {
  const matches: Record<string, string> = {};
  for (let start = 0; start < labels.length; start += CHUNK) {
    const chunk = labels.slice(start, start + CHUNK);
    const result = await request<{ matches: Record<string, string> }>(`/api/tables/${tableId}/records/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: chunk }),
    });
    Object.assign(matches, result.matches);
  }
  return matches;
}
