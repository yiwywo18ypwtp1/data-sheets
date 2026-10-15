import { expect, test, type Page } from "@playwright/test";
import { cell, gridReady, openView } from "./helpers";

const TABLE = "/b/bas_demo/tbl_products/viw_products_all";
const NAME_COLUMN = 0;

async function nameOfRow(page: Page, offset: number): Promise<{ id: string; name: string; rev: number }> {
  const response = await page.request.get(`/api/tables/tbl_products/rows?offset=${offset}&limit=1`);
  const { rows } = (await response.json()) as { rows: { id: string; rev: number; values: Record<string, unknown> }[] };
  return { id: rows[0].id, name: String(rows[0].values.fld_p_name ?? ""), rev: rows[0].rev };
}

/** The first visit installs the worker and tells it who is signed in; a reload then goes through it and is kept. */
async function visitUntilWorkerHasThePage(page: Page, user: string) {
  await openView(page, TABLE);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain(`meta-v2`);
  await page.reload();
  await gridReady(page);
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain(`pages-v2:${user}`);
}

/** A record as an earlier tab of `userId` would have left it in the browser's IndexedDB. */
async function leaveUnsentEdit(page: Page, userId: string, edit: { rowId: string; rev: number; name: string }) {
  await page.evaluate(
    ({ userId, edit }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("data-sheets-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction("outbox", "readwrite");
          transaction.objectStore("outbox").put({
            ownerId: `tab_gone_${userId}`,
            userId,
            tableId: "tbl_products",
            edits: [{ op: "update", rowId: edit.rowId, values: { fld_p_name: edit.name }, rev: edit.rev }],
            savedAt: new Date().toISOString(),
          });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { userId, edit },
  );
}

/** Row copies as the grid keeps them after loading windows (see offline/windowCache.ts), one per user. */
async function leaveRowCopies(page: Page, userIds: string[]) {
  await page.evaluate(
    (userIds) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("data-sheets-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction("windows", "readwrite");
          for (const userId of userIds) {
            transaction.objectStore("windows").put({ key: `${userId}|tbl_products|test`, userId, tableId: "tbl_products", savedAt: Date.now(), value: { rows: [] } });
          }
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    userIds,
  );
}

const outboxSize = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("data-sheets-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const count = open.result.transaction("outbox").objectStore("outbox").count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );

async function switchUser(page: Page, name: RegExp) {
  await page.goto("/settings");
  await page.getByLabel(name).check();
  await page.getByRole("button", { name: "Switch user" }).click();
  await expect(page.getByRole("link", { name: name })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

/** Values differ per run, so a rerun against the same database still changes something. */
const unique = (text: string) => `${text} ${Date.now().toString(36)}`;

test("offline: edits wait in the queue, survive a reload from the saved page, and are sent when the network returns", async ({ page, context }) => {
  await visitUntilWorkerHasThePage(page, "usr_creator");
  const target = await nameOfRow(page, 5);

  const typed = unique("Typed offline");
  await context.setOffline(true);
  await cell(page, 5, NAME_COLUMN).click();
  await page.keyboard.type(typed);
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Offline · 1 change waiting/)).toBeVisible();
  await expect.poll(() => outboxSize(page)).toBe(1);
  expect((await nameOfRow(page, 5)).name).toBe(target.name); // the server hasn't seen it

  // The page itself comes from the worker's copy, and the unsent edit is taken over by the new grid.
  await page.reload();
  await expect(page.getByRole("gridcell").first()).toBeVisible();
  await expect(cell(page, 5, NAME_COLUMN)).toHaveText(typed);
  await expect(page.getByText(/Offline · (saved copy · )?1 change waiting/)).toBeVisible();

  await context.setOffline(false);
  await expect.poll(async () => (await nameOfRow(page, 5)).name, { timeout: 30_000 }).toBe(typed);
  await expect.poll(() => outboxSize(page)).toBe(0);
});

test("offline: after the user is switched, the new user doesn't send, see or find the old user's data", async ({ page }) => {
  await visitUntilWorkerHasThePage(page, "usr_creator");
  const target = await nameOfRow(page, 7);
  const typed = unique("Typed as Cora");
  await leaveUnsentEdit(page, "usr_creator", { rowId: target.id, rev: target.rev, name: typed });


  await switchUser(page, /Eddie Editor/);
  // Row copies of both are on the device (Eddie's own are made by his grid; these stand in for them).
  await leaveRowCopies(page, ["usr_creator", "usr_editor"]);
  await openView(page, TABLE);
  // Eddie's grid doesn't take Cora's edit over. It stays where it is, and nothing is sent in her name or his.
  await page.waitForTimeout(1500);
  expect(await outboxSize(page)).toBe(1);
  expect((await nameOfRow(page, 7)).name).toBe(target.name);
  await expect(cell(page, 7, NAME_COLUMN)).toHaveText(target.name);
  // Cora's saved pages and row copies are gone from the device; the worker only knows Eddie now.
  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain("pages-v2:usr_creator");
  const copyOwners = () =>
    page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const open = indexedDB.open("data-sheets-offline");
          open.onsuccess = () => {
            const all = open.result.transaction("windows").objectStore("windows").getAll();
            all.onsuccess = () => resolve([...new Set((all.result as { userId: string }[]).map((entry) => entry.userId))]);
          };
        }),
    );
  await expect.poll(copyOwners).toEqual(["usr_editor"]);

  // Back as Cora, the edit is hers again: the grid takes it over and sends it.
  await switchUser(page, /Cora Creator/);
  await openView(page, TABLE);
  await expect.poll(async () => (await nameOfRow(page, 7)).name, { timeout: 15_000 }).toBe(typed);
  await expect.poll(() => outboxSize(page)).toBe(0);
});

test("a page left open across a user switch can't save under the new user's name", async ({ page, context }) => {
  await openView(page, TABLE);
  const target = await nameOfRow(page, 9);

  const other = await context.newPage(); // the same browser: the cookie is shared
  await switchUser(other, /Vera Viewer/);

  await cell(page, 9, NAME_COLUMN).click();
  await page.keyboard.type(unique("Stale tab edit"));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 change couldn't be saved" })).toBeVisible();
  await expect(cell(page, 9, NAME_COLUMN)).toHaveText(target.name); // rolled back
  expect((await nameOfRow(page, 9)).name).toBe(target.name);

  await switchUser(other, /Cora Creator/); // leave the shared database as the other tests expect it
});
