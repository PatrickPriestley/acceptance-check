// The example app has no dependencies and no build, so install and build do nothing.
/** @type {import("../src/config.mjs").AcceptanceConfig} */
export default {
  install: ["node", "-e", ""],
  build: ["node", "-e", ""],
  buildOutputs: ["app/server.mjs"],
  sources: ["app"],
  start: {
    command: ["node", "app/server.mjs"],
    health: "/health",
    env: { PORT: "{port}" },
  },
  specDir: "tests",
  notes: "notes.md",
  report: { setting: "with an empty list" },
  // Deliberate faults for the break check. A @holds test names the one it should catch.
  breaks: [
    {
      name: "items-not-saved",
      description: "The server accepts a new item but does not keep it.",
      file: "app/server.mjs",
      find: 'items.push(String(JSON.parse(body).name ?? ""));',
      replace: "JSON.parse(body);",
    },
  ],
};
