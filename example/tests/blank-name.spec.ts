import { test, expect, recordRequests } from "./fixtures";

test('A blank name shows "Enter a name for the item." and saves nothing', { tag: "@new" }, async ({ page, request }) => {
  const saves = recordRequests(page, "POST", "/api/items");
  await page.goto("/");
  const form = page.getByRole("form", { name: "Add item" });
  await form.getByLabel("Item name").fill("   ");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter a name for the item.");
  expect(saves).toHaveLength(0);
  expect(await (await request.get("/api/items")).json()).toEqual([]);
});

test("A real name is trimmed and added to the list", { tag: "@holds" }, async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Add item" });
  await form.getByLabel("Item name").fill("  Coffee ");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("region", { name: "Items" }).getByRole("listitem")).toHaveText(["Coffee"]);
});
