import { expect, test } from "@playwright/test";
import { cell, gridReady, openView } from "./helpers";

test("paste a range from the clipboard, undo it with one Cmd+Z, redo with Shift+Cmd+Z", async ({ page }) => {
  await openView(page, "/b/bas_demo/tbl_products/viw_products_all");
  // Name (text) and SKU (text): 3 rows × 2 columns.
  const before = await Promise.all([0, 1, 2].map(async (row) => [await cell(page, row, 0).innerText(), await cell(page, row, 1).innerText()]));
  await cell(page, 0, 0).click();

  // A paste as Google Sheets puts it on the clipboard (TSV). Dispatched as a paste event:
  // headless browsers don't share a system clipboard.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "Lamp\tL-1\nDesk\tD-2\nChair\tC-3\n");
    document.querySelector('[role="grid"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await expect(cell(page, 2, 1)).toHaveText("C-3");
  await expect(cell(page, 0, 0)).toHaveText("Lamp");

  await page.getByRole("grid").press("ControlOrMeta+z");
  for (const [row, [name, sku]] of before.entries()) {
    await expect(cell(page, row, 0)).toHaveText(name);
    await expect(cell(page, row, 1)).toHaveText(sku);
  }

  await page.getByRole("grid").press("ControlOrMeta+Shift+z");
  await expect(cell(page, 0, 0)).toHaveText("Lamp");
  await expect(cell(page, 2, 1)).toHaveText("C-3");

  // The redo reached the server: a reload shows it.
  await page.waitForTimeout(500);
  await page.reload();
  await gridReady(page);
  await expect(cell(page, 1, 0)).toHaveText("Desk");
});
