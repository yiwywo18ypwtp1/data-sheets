import { expect, test, type Page } from "@playwright/test";
import { gridReady } from "./helpers";

/** A new board on Orders, stacked by Status. Boards have no grid: "Live" shows that the client code runs. */
async function openBoard(page: Page) {
  await page.goto("/b/bas_demo/tbl_orders/viw_orders_all");
  await gridReady(page);
  await page.getByRole("button", { name: "Add a view" }).click();
  await page.getByRole("menuitem", { name: "Kanban board" }).click();
  await page.getByRole("combobox", { name: "Stacked by" }).selectOption({ label: "Status" });
  const board = page.getByRole("group", { name: /board, stacked by Status/ });
  await expect(board).toBeVisible();
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
  return board;
}

const statusOf = async (page: Page, rowId: string) => {
  const { row } = (await (await page.request.get(`/api/tables/tbl_orders/rows/${rowId}`)).json()) as { row: { values: Record<string, unknown> } };
  return (row.values.fld_o_status as string | undefined) ?? "";
};

test("kanban: a card moves by drag and drop and by keyboard, undo brings it back, a column adds a record", async ({ page }) => {
  const board = await openBoard(page);
  const columns = board.locator("section[data-column]");
  // Column 0 holds records without a status; 1.. are the options in order.
  const [from, next, far] = [1, 2, 4].map((index) => columns.nth(index));
  const [fromKey, nextKey, farKey] = await Promise.all([from, next, far].map((column) => column.getAttribute("data-column") as Promise<string>));

  // Alt+→ moves the focused card to the next column; the server has it, too.
  const card = from.locator("[data-card]").first();
  const rowId = (await card.getAttribute("data-card"))!;
  await card.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(next.locator(`[data-card="${rowId}"]`)).toBeVisible();
  await expect(from.locator(`[data-card="${rowId}"]`)).toHaveCount(0);
  await expect.poll(() => statusOf(page, rowId)).toBe(nextKey);

  // Undo puts it back (in the board and on the server).
  await page.keyboard.press("Control+z");
  await expect(from.locator(`[data-card="${rowId}"]`)).toBeVisible();
  await expect.poll(() => statusOf(page, rowId)).toBe(fromKey);

  // Drag and drop onto a column two steps away.
  await from.locator(`[data-card="${rowId}"]`).dragTo(far);
  await expect(far.locator(`[data-card="${rowId}"]`)).toBeVisible();
  await expect.poll(() => statusOf(page, rowId)).toBe(farKey);

  // "+ Add record" in a column creates a record with that status.
  const countBefore = Number((await far.locator("header span").last().innerText()).replaceAll(/\D/g, ""));
  await far.getByRole("button", { name: "+ Add record" }).click();
  await page.keyboard.type("E2E board card");
  await page.keyboard.press("Enter");
  // The column is long, so the new card is at its far end, behind "Show more": the count and the server show it.
  await expect.poll(async () => Number((await far.locator("header span").last().innerText()).replaceAll(/\D/g, ""))).toBe(countBefore + 1);
  const found = (await (await page.request.get("/api/tables/tbl_orders/records/search?q=E2E%20board%20card")).json()) as { records: { id: string; label: string }[] };
  expect(found.records.map((record) => record.label)).toContain("E2E board card");
});

test("kanban: a board is read-only for a viewer", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://localhost:3100" });
  await context.addCookies([{ name: "ds_user", value: "usr_viewer", url: "http://localhost:3100" }]);
  const page = await context.newPage();
  const views = (await (await page.request.get("/api/tables/tbl_orders")).json()) as { table: { views: { id: string; kind: string }[] } };
  const board = views.table.views.find((view) => view.kind === "kanban");
  test.skip(!board, "needs the board the previous test created");
  await page.goto(`/b/bas_demo/tbl_orders/${board!.id}`);
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
  const card = page.locator("[data-card]").first();
  await expect(card).toHaveAttribute("draggable", "false");
  await expect(page.getByRole("button", { name: "+ Add record" })).toHaveCount(0);
  await context.close();
});
