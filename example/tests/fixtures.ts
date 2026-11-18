import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/** Records the requests the page sends to one path. Register it before the page loads. */
export function recordRequests(page: Page, method: string, path: string) {
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.method() === method && new URL(request.url()).pathname === path) bodies.push(request.postData() ?? "");
  });
  return bodies;
}

export const test = base.extend<{ resetApp: void }>({
  resetApp: [
    async ({ request }, use) => {
      expect((await request.post("/api/reset")).ok(), "empty the list").toBe(true);
      await use();
    },
    { auto: true },
  ],
});
