import { expect, test, type Browser, type Page } from "@playwright/test";
import { cell, openView } from "./helpers";

async function tab(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: "http://localhost:3100" });
  await context.addCookies([{ name: "ds_user", value: user, url: "http://localhost:3100" }]);
  const page = await context.newPage();
  await openView(page, "/b/bas_demo/tbl_products/viw_products_all");
  return page;
}

async function edit(page: Page, row: number, col: number, text: string) {
  await cell(page, row, col).click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("two tabs edit one row: different cells merge, the same cell shows a conflict", async ({ browser }) => {
  const a = await tab(browser, "usr_creator");
  const b = await tab(browser, "usr_editor");
  const row = 7;

  // Different cells of the same row, at the same time: both edits survive, in both tabs.
  await Promise.all([edit(a, row, 0, "Merged name"), edit(b, row, 1, "MERGED-SKU")]);
  for (const page of [a, b]) {
    await expect(cell(page, row, 0)).toHaveText("Merged name");
    await expect(cell(page, row, 1)).toHaveText("MERGED-SKU");
  }

  // The same cell: A writes, then B overwrites. Last write wins; A is told and can restore its value.
  await edit(a, row, 1, "FROM-A");
  await expect(cell(b, row, 1)).toHaveText("FROM-A");
  await edit(b, row, 1, "FROM-B");
  await expect(cell(a, row, 1)).toHaveText("FROM-B");
  await expect(a.getByText(/changed SKU to “FROM-B” after you set it to “FROM-A”/)).toBeVisible();
  await a.getByRole("button", { name: "Keep mine" }).click();
  await expect(cell(b, row, 1)).toHaveText("FROM-A");
});
