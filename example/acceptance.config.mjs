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
};
