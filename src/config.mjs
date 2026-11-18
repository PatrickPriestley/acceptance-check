// Finds and loads acceptance.config.mjs: everything the engine and its agent need
// to know about how one app builds and runs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_FILE = "acceptance.config.mjs";

/**
 * @typedef {object} AcceptanceConfig
 * @property {string[]} install Installs dependencies in an exported base revision.
 * @property {string[]} build Builds the app. Runs for this checkout and for the base.
 * @property {string[]} buildOutputs Files the build produces. `--skip-build` refuses when sources are newer.
 * @property {string[]} sources Folders whose changes make a build stale.
 * @property {{ command: string[], health: string, allowEnv?: string[], env?: Record<string, string> }} start
 *   Starts one isolated copy of the app. Only `allowEnv` names pass through from the environment.
 *   In `env` values, `{port}` is a free port and `{data}` is a fresh folder for this copy.
 * @property {string} specDir Where acceptance specs live. The agent may write only here.
 * @property {string} [playwrightConfig] A Playwright config to use instead of the built-in one.
 * @property {string} [notes] Markdown with app facts for whoever writes the tests.
 * @property {string} [outputDir] Where runs, base builds and agent logs go. Default `.acceptance`.
 * @property {{ setting?: string, limits?: string }} [report] A phrase on the test setting and a sentence on its limits.
 */

/** The nearest folder at or above `start` that holds acceptance.config.mjs. */
export function findProjectRoot(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    if (dirname(dir) === dir) throw new Error(`No ${CONFIG_FILE} in ${start} or any folder above it. Run \`acceptance-check init\` to create one.`);
  }
}

/** @returns {Promise<AcceptanceConfig & { start: Required<AcceptanceConfig["start"]>, outputDir: string, notes: string | null, playwrightConfig: string | null, report: { setting: string, limits: string } }>} */
export async function loadConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`No ${CONFIG_FILE} at ${root}. It tells the acceptance checker how to build and start the app.`);
  return validateConfig(root, (await import(pathToFileURL(file).href)).default ?? {});
}

export function validateConfig(root, config) {
  const problems = [];
  // The program must be named; its arguments may be any string, empty included.
  const isCommand = (value) => Array.isArray(value) && typeof value[0] === "string" && value[0] !== "" && value.every((part) => typeof part === "string");
  for (const [name, value] of [["install", config.install], ["build", config.build], ["start.command", config.start?.command]]) {
    if (!isCommand(value)) problems.push(`${name} must be a command as an array of strings`);
  }
  for (const name of ["buildOutputs", "sources"]) {
    if (!Array.isArray(config[name]) || !config[name].length) problems.push(`${name} must list at least one path`);
  }
  if (typeof config.start?.health !== "string" || !config.start.health.startsWith("/")) problems.push("start.health must be a path such as /health");
  if (typeof config.specDir !== "string" || !config.specDir) problems.push("specDir must be a path");
  for (const name of ["notes", "playwrightConfig"]) {
    if (config[name] !== undefined && !existsSync(join(root, config[name]))) problems.push(`${name} file ${config[name]} does not exist`);
  }
  if (problems.length) throw new Error(`${CONFIG_FILE}: ${problems.join("; ")}`);
  return {
    ...config,
    specDir: config.specDir.replace(/\/+$/, ""),
    start: { allowEnv: ["PATH", "HOME"], env: {}, ...config.start },
    notes: config.notes ?? null,
    playwrightConfig: config.playwrightConfig ?? null,
    outputDir: config.outputDir ?? ".acceptance",
    report: { setting: "", limits: "", ...config.report },
  };
}

/** Replaces `{port}` and `{data}` in each value. */
export function expandEnv(env, values) {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, String(value).replace(/\{(port|data)\}/g, (_, key) => String(values[key]))]));
}

/** The app notes for the agent, or a line saying there are none. */
export function readNotes(root, config) {
  return config.notes ? readFileSync(join(root, config.notes), "utf8").trim() : "This repository provides no app notes. Learn the app from its code.";
}
