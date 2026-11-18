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
  // Runs before every test, so tests cannot affect each other. Put the app into a
  // known state here: call a reset or seed endpoint, or save known data.
  resetApp: [
    async ({ request }, use) => {
      // Replace with your app's reset, for example:
      // expect((await request.post("/api/test/reset")).ok()).toBe(true);
      void request;
      await use();
    },
    { auto: true },
  ],
});
