// The built-in Playwright config. The engine sets these variables for each run.
// It imports nothing, so it works with whichever @playwright/test the project has.
const { ACCEPTANCE_BASE_URL, ACCEPTANCE_OUTPUT, ACCEPTANCE_REPORT, ACCEPTANCE_SPEC_DIR } = process.env;
if (!ACCEPTANCE_BASE_URL || !ACCEPTANCE_SPEC_DIR)
  throw new Error("Run acceptance specs through `acceptance-check verify`, which starts an isolated copy of the app for each side.");

export default {
  testDir: ACCEPTANCE_SPEC_DIR,
  testMatch: "*.spec.ts",
  outputDir: ACCEPTANCE_OUTPUT,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ACCEPTANCE_REPORT }]],
  use: {
    baseURL: ACCEPTANCE_BASE_URL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    video: "on",
    trace: "on",
    screenshot: "on",
  },
};
