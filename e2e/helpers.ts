import { expect, type Page } from "@playwright/test";

/** A grid cell by position in the view (rows and columns are virtualized: found by data attributes). */
export const cell = (page: Page, row: number, col: number) => page.locator(`[data-row="${row}"][data-col="${col}"]`);

/** The grid's record count, from its ARIA row count (header and footer excluded). */
export async function recordCount(page: Page): Promise<number> {
  return Number(await page.getByRole("grid").getAttribute("aria-rowcount")) - 2;
}

/**
 * Waits until the grid is interactive: it has data, and "Live" shows that the client
 * code runs (realtime connects after hydration). Clicking earlier can hit server HTML.
 */
export async function gridReady(page: Page) {
  await expect(page.getByRole("gridcell").first()).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
}

export async function openView(page: Page, path: string) {
  await page.goto(path);
  await gridReady(page);
}
