import { test, expect } from "./fixtures";

// Behaviour that must keep working. The test names the break from the config that it
// should catch: the break check applies that fault and the test must fail there.
test("An added item stays on the list after a reload", { tag: "@holds", annotation: { type: "catches", description: "items-not-saved" } }, async ({ page }) => {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Add item" });
  await form.getByLabel("Item name").fill("Coffee");
  await form.getByRole("button", { name: "Add" }).click();
  // The app reloads the page itself after adding; let that finish before reloading again.
  const items = page.getByRole("region", { name: "Items" }).getByRole("listitem");
  await expect(items).toHaveText(["Coffee"]);
  await page.reload();
  await expect(items).toHaveText(["Coffee"]);
});
