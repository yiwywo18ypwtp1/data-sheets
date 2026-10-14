import { expect, test } from "@playwright/test";
import { cell, gridReady, openView, recordCount } from "./helpers";

test("filter, sort and save a view; after a reload it's the same", async ({ page }) => {
  await openView(page, "/b/bas_demo/tbl_orders/viw_orders_all");
  const all = await recordCount(page);

  await page.getByRole("button", { name: /Filter & sort/ }).click();
  await page.getByRole("button", { name: "+ Add condition", exact: true }).click();
  const condition = page.locator("form[aria-label='View settings'] li").first();
  await condition.getByLabel("Field").selectOption({ label: "Qty" });
  await condition.getByLabel("Operator for Qty").selectOption("gt");
  await condition.getByLabel("Value for Qty").fill("10");
  await page.getByRole("button", { name: "+ Add sort" }).click();
  await page.getByLabel("Sort field 1").selectOption({ label: "Qty" });
  await page.getByLabel("Direction for Qty").selectOption("desc");

  await expect.poll(() => recordCount(page)).toBeLessThan(all);
  const filtered = await recordCount(page);
  await expect(page.getByText("Unsaved view changes")).toBeVisible();
  const qtyColumn = 3; // Order #, Customer, Product, Qty
  const firstQty = await cell(page, 0, qtyColumn).innerText();

  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByText("Unsaved view changes")).toBeHidden();

  await page.reload();
  await gridReady(page);
  expect(await recordCount(page)).toBe(filtered);
  await expect(cell(page, 0, qtyColumn)).toHaveText(firstQty);
  await page.getByRole("button", { name: /Filter & sort/ }).click();
  await expect(page.getByLabel("Value for Qty")).toHaveValue("10");
  await expect(page.getByLabel("Direction for Qty")).toHaveValue("desc");
  await expect(page.getByText("Unsaved view changes")).toBeHidden();
});
