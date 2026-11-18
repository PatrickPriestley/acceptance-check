import { test, expect } from "./fixtures";

test("The list shows how many items it holds", { tag: "@new" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("0 items");
  const form = page.getByRole("form", { name: "Add item" });
  await form.getByLabel("Item name").fill("Coffee");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("status")).toHaveText("1 item");
});
