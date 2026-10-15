import { expect, test, type Browser, type Page } from "@playwright/test";
import { openView } from "./helpers";

const RECORD = "row_p_00003";
const TABLE = "/b/bas_demo/tbl_products/viw_products_all";

async function tab(browser: Browser, user: string, path: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: "http://localhost:3100" });
  await context.addCookies([{ name: "ds_user", value: user, url: "http://localhost:3100" }]);
  const page = await context.newPage();
  await openView(page, path);
  return page;
}

test("a comment with an @mention reaches the mentioned user live, in the record and in their inbox", async ({ browser }) => {
  const author = await tab(browser, "usr_creator", `${TABLE}?record=${RECORD}`);
  const reader = await tab(browser, "usr_editor", TABLE); // the same table, but no record open
  const panel = author.getByRole("dialog").filter({ has: author.getByRole("tab", { name: "Comments" }) });
  await expect(panel).toBeVisible();

  // "@Ed" opens the people list; Enter picks the first match and inserts the name.
  await panel.getByPlaceholder(/Add a comment/).click();
  await author.keyboard.type("Hi @Ed");
  await expect(author.getByRole("option", { name: /Eddie Editor/ })).toBeVisible();
  await author.keyboard.press("Enter");
  await author.keyboard.type("please check the price");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  const posted = panel.getByRole("list", { name: "Comments" }).getByText(/please check the price/);
  await expect(posted).toBeVisible();
  await expect(posted).toContainText("@Eddie Editor");

  // The editor is told without reloading: the unread badge, then the entry; opening it shows the record's comments.
  const badge = reader.getByRole("button", { name: /^Mentions/ });
  await expect(badge).toHaveAttribute("aria-label", /unread/, { timeout: 15_000 });
  const unreadBefore = Number(/\d+/.exec((await badge.getAttribute("aria-label"))!)![0]);
  await badge.click();
  await reader.getByRole("dialog", { name: "Mentions" }).getByRole("button", { name: /please check the price/ }).first().click();
  const readerPanel = reader.getByRole("dialog").filter({ has: reader.getByRole("tab", { name: "Comments" }) });
  await expect(readerPanel.getByText(/please check the price/)).toBeVisible();
  // Opening the entry marked that mention as read.
  await expect(badge).toHaveAttribute("aria-label", unreadBefore === 1 ? "Mentions" : `Mentions, ${unreadBefore - 1} unread`);

  // The author deletes the comment: it disappears from the editor's open panel as well.
  await posted.hover();
  await panel.getByRole("button", { name: "Delete" }).click();
  await expect(posted).toHaveCount(0);
  await expect(readerPanel.getByText(/please check the price/)).toHaveCount(0);

  await author.context().close();
  await reader.context().close();
});
