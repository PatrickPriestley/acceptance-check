// How this app builds and runs, for acceptance-check. Every command is an array:
// the program, then its arguments. Nothing runs through a shell.
/** @type {import("acceptance-check/src/config.mjs").AcceptanceConfig} */
export default {
  // Installs dependencies in an exported copy of the base revision.
  install: ["npm", "ci"],
  // Builds the app. Runs for this checkout and for the base.
  build: ["npm", "run", "build"],
  // Files the build produces, and folders whose changes make a build stale.
  buildOutputs: ["dist/server.js"],
  sources: ["src"],
  start: {
    // Start the built app directly, not through a script that loads .env.
    command: ["node", "dist/server.js"],
    // A path that answers 200 once the app is ready.
    health: "/health",
    // Only these variables pass through from the environment. Keep secrets out.
    allowEnv: ["PATH", "HOME"],
    // {port} is a free port and {data} a fresh folder, for each copy.
    env: {
      PORT: "{port}",
      DATA_DIR: "{data}",
    },
  },
  // Where acceptance specs live. The agent may write only here.
  specDir: "tests/acceptance",
  // App facts for whoever writes the tests, people and the agent.
  notes: "docs/acceptance-notes.md",
  report: {
    setting: "with test data",
    limits: "",
  },
  // Optional deliberate faults. A @holds test names the one it should catch with
  // annotation: { type: "catches", description: "<name>" }, and must fail with it.
  breaks: [],
};
