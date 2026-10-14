import { expect, test } from "@playwright/test";

const CSV = ["Name;SKU;Price;In stock", "Lamp;IMP-1;12,50;3", "Desk;IMP-2;abc;4", "Chair;IMP-3;99;many", "Shelf;IMP-4;45;n/a", "Table;IMP-5;150;7"].join("\n");

test("CSV import with errors: fix one in the preview, skip the others, check the result", async ({ page, request }) => {
  const count = async () => ((await (await request.get("/api/tables/tbl_products/rows?limit=1")).json()) as { total: number }).total;
  const before = await count();

  await page.goto("/b/bas_demo/tbl_products/import", { waitUntil: "networkidle" });
  await page.getByLabel("CSV file", { exact: true }).setInputFiles({ name: "products.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
  await expect(page.getByText(/5 rows · 4 columns/)).toBeVisible();
  await expect(page.getByLabel("Delimiter")).toHaveValue(";");

  await page.getByRole("button", { name: "Next: map columns" }).click();
  await expect(page.getByLabel("Field for Price")).toHaveValue("fld_p_price");
  await page.getByRole("button", { name: "Next: check values" }).click();

  // Three rows have a bad value: row 3 (Price "abc"), 4 (In stock "many"), 5 (In stock "n/a").
  await expect(page.getByRole("status").first()).toContainText("3 rows have 3 values");
  await page.getByLabel("Value of Price in row 3").fill("20");
  await expect(page.getByRole("row", { name: /^3 Price/ })).toContainText("Fixed");
  await page.getByLabel("Skip rows with errors").check();
  await page.getByRole("button", { name: "Import 3 rows" }).click();
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(page.getByText("Import finished.")).toBeVisible();
  const summary = page.locator("dl");
  await expect(summary).toContainText("Imported3");
  await expect(summary).toContainText("Skipped (errors)2");
  await expect(page.getByRole("link", { name: /Download the report \(2 problems\)/ })).toBeVisible();
  expect(await count()).toBe(before + 3);
});
