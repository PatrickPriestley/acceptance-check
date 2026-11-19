// Writes acceptance tests from a pull request description with a Claude Code agent,
// then checks them independently with a separate verify run.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError, runAgent } from "./agent.mjs";
import { parseCriteria } from "./criteria.mjs";
import { findProjectRoot, loadConfig, readNotes } from "./config.mjs";
import { verify } from "./verify.mjs";

const BIN = fileURLToPath(new URL("../bin/acceptance-check.mjs", import.meta.url));
const SKILL = fileURLToPath(new URL("../skills/verify-acceptance/SKILL.md", import.meta.url));
const PROMPT = fileURLToPath(new URL("./agent-prompt.md", import.meta.url));
const log = (message) => console.log(`[acceptance-check write] ${message}`);

class WriteError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{ cwd?: string, body: string, spec: string, base?: string, model?: string, maxBudgetUsd?: string, maxRuns?: string, agent?: string }} options
 * @returns {Promise<{ code: number, report: string | null, spec: string }>}
 *   code 0 when every criterion is met or still holds, 2 when one is not, 3 when the description has no criteria, 1 otherwise.
 */
export async function write(options) {
  try {
    return await run(options);
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    console.error(`[acceptance-check write] ${error.message}`);
    return { code: error.code, report: null, spec: options.spec };
  }
}

/** The Exploration section of the agent prompt. */
export function describeExplore(explore, command) {
  const files = explore.properties.map((file) => `\`${file}\``).join(", ");
  return `## Exploration

${explore.description ?? "This app has a property-based explorer"}. You may add properties in ${files}: promises that must hold after any sequence of actions, checked by random exploration of the running app.

- If this change adds or alters state a user can see (counts, ticks, quantities, what survives navigation or a reload) and makes a promise that must hold after any sequence of actions, add or adjust a property there. Guard it so it cannot pass just because something was not observed. If there is no such promise, change nothing there and say why.
- Run the explorer with exactly this command, allowing it up to 10 minutes:
  \`${command}\`
  It explores this change, and the base as well when it finds a violation. Read the \`explore.md\` it names.
- "New violation": read the trace and log in the folder the report names. If the property is right, the change has a bug: add one more test to the spec that replays the shortest path the trace shows, tagged \`@holds\` and titled "Found by exploration: <what goes wrong>". It fails on this change, and that failure is the finding. If the property is wrong, fix the property instead.
- "Violation also on the base": not caused by this change. Report it and move on.
- Run the explorer at most 2 times.

`;
}

/** The config's breaks, as a list for the agent prompt. */
export function describeBreaks(breaks) {
  if (!breaks.length) return "This app's config defines no breaks, so name none. Say in your report which breaks would let the check prove the `@holds` tests can fail.";
  return breaks.map((item) => `- \`${item.name}\`: ${item.description ?? `changes ${item.file}`}`).join("\n");
}

async function run(options) {
  const root = findProjectRoot(resolve(options.cwd ?? process.cwd()));
  const config = await loadConfig(root).catch((error) => { throw new WriteError(error.message); });
  const spec = relative(root, resolve(options.cwd ?? process.cwd(), options.spec));
  if (dirname(spec) !== config.specDir || !/^[\w.-]+\.spec\.ts$/.test(spec.slice(config.specDir.length + 1))) {
    throw new WriteError(`The spec must be a file directly in ${config.specDir}/: ${spec}`);
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel").trim();
  // Paths relative to the project root, whatever folder of the repository it is in.
  const changedPaths = () =>
    git("status", "--porcelain=v1", "--untracked-files=all", "--", ".").split("\n").filter(Boolean)
      .map((line) => relative(root, join(top, line.slice(3).replace(/^.* -> /, ""))));

  const criteria = parseCriteria(readFileSync(resolve(options.body), "utf8"));
  if (!criteria.length) throw new WriteError('No "## Acceptance criteria" section with list items in the description.', 3);
  const base = git("rev-parse", "--verify", `${options.base ?? "origin/main"}^{commit}`).trim();

  // The agent may change only the spec. Start from a tree where anything else it
  // touches can be detected and undone without losing someone's work.
  const dirty = changedPaths().filter((path) => path !== spec);
  if (dirty.length) throw new WriteError(`Commit or stash these first, so the agent's changes can be told apart: ${dirty.join(", ")}`);

  const runDir = join(root, config.outputDir, "agent", `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const criteriaFile = join(runDir, "criteria.json");
  writeFileSync(criteriaFile, JSON.stringify(criteria, null, 2));
  log(`${criteria.length} criteria. Run folder ${relative(root, runDir)}`);

  // Build this change and the base before the agent starts, so each check it runs
  // reuses both builds and finishes well inside its tool time limit.
  log("Building this change and the base");
  const prepared = await verify({ cwd: root, base, prepareOnly: true, specs: [] });
  if (prepared.code !== 0) throw new WriteError("The builds failed. See the run folder named above.");

  const inProject = (path) => (relative(root, path).startsWith("..") || isAbsolute(relative(root, path)) ? path : relative(root, path));
  const quote = (text) => (/^[\w./@:=-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);
  const checkPrefix = `node ${quote(BIN)} verify`;
  const check = `${checkPrefix} --base=${base} --skip-build --criteria=${quote(relative(root, criteriaFile))} ${spec}`;
  // Property files are inside specDir (the config requires it), so exploration
  // needs no write access beyond what the agent already has: only the run command.
  const properties = config.explore?.properties ?? [];
  const explorePrefix = `node ${quote(BIN)} explore`;
  const prompt = readFileSync(PROMPT, "utf8")
    .replaceAll("{{EXPLORE_FILES}}", properties.length ? ` and the property files ${properties.map((file) => `\`${file}\``).join(", ")}` : "")
    .replaceAll("{{EXPLORE}}", config.explore ? describeExplore(config.explore, `${explorePrefix} --base=${base} --skip-build`) : "")
    .replaceAll("{{SPEC}}", spec)
    .replaceAll("{{BASE}}", base)
    .replaceAll("{{SKILL}}", inProject(SKILL))
    .replaceAll("{{CHECK}}", check)
    .replaceAll("{{MAX_RUNS}}", options.maxRuns ?? "4")
    .replaceAll("{{APP_NOTES}}", readNotes(root, config))
    .replaceAll("{{BREAKS}}", describeBreaks(config.breaks))
    .replaceAll("{{CRITERIA}}", criteria.map((criterion) => `- ${criterion}`).join("\n"));
  // File writes are limited to the spec folder. Shell commands that write files
  // are refused; Claude Code still allows read-only ones such as cat.
  const tools = ["Read", "Glob", "Grep", `Write(${config.specDir}/**)`, `Edit(${config.specDir}/**)`,
    `Bash(${checkPrefix}:*)`, "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
    ...(config.explore ? [`Bash(${explorePrefix}:*)`] : [])];
  log("Agent is writing the tests");
  let result, notes;
  try {
    ({ result, notes } = await runAgent({ root, runDir, prompt, tools, model: options.model, maxBudgetUsd: options.maxBudgetUsd, agent: options.agent, log }));
  } catch (error) {
    if (error instanceof AgentError) throw new WriteError(error.message);
    throw error;
  }

  const allowed = [spec, ...properties];
  const outside = changedPaths().filter((path) => !allowed.includes(path));
  if (outside.length) {
    const tracked = outside.filter((path) => git("ls-files", "--", path).trim());
    if (tracked.length) git("checkout", "--", ...tracked);
    for (const path of outside.filter((path) => !tracked.includes(path))) rmSync(join(root, path), { recursive: true, force: true });
    throw new WriteError(`The agent changed files outside ${spec}, which were undone: ${outside.join(", ")}`);
  }
  if (!existsSync(join(root, spec))) throw new WriteError(`The agent wrote no spec at ${spec}. Its notes are in ${relative(root, join(runDir, "agent-notes.md"))}`);

  // The verdicts come from a fresh run, not from what the agent says it saw.
  log("Checking the tests independently");
  const outputFile = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  const checked = await verify({ cwd: root, base, skipBuild: true, criteria: criteriaFile, specs: [spec] });
  // A property the agent added or changed is explored again in a separate run, too.
  const changedProperties = changedPaths().filter((path) => properties.includes(path));
  const explored = changedProperties.length ? await verify({ cwd: root, base, skipBuild: true, explore: true, specs: [] }) : null;
  if (outputFile) process.env.GITHUB_OUTPUT = outputFile;

  if (checked.report) {
    const cost = result?.total_cost_usd === undefined ? "" : ` It took ${result.num_turns} turns and cost $${result.total_cost_usd.toFixed(2)}.`;
    appendFileSync(checked.report, [
      "",
      "<details><summary>How these tests were written</summary>",
      "",
      `An agent wrote \`${spec}\` from the criteria in the pull request description.${cost} The verdicts above come from a separate run after it finished. Its notes:`,
      "",
      ...notes.slice(0, 4000).split("\n").map((line) => `> ${line}`),
      "",
      "</details>",
      "",
    ].join("\n"));
    if (explored?.report) {
      const exploration = readFileSync(explored.report, "utf8").replace("<!-- acceptance-explore -->\n## Exploration", `### Exploration\n\nThe agent changed ${changedProperties.map((file) => `\`${file}\``).join(", ")}, so it was explored again in a separate run.`);
      appendFileSync(checked.report, `\n${exploration}`);
    }
  }
  const code = checked.code !== 0 ? checked.code : explored && explored.code !== 0 ? explored.code : 0;
  if (outputFile && checked.report) appendFileSync(outputFile, `report=${checked.report}\nspec=${spec}\nfiles=${[spec, ...changedProperties].join(" ")}\n`);
  log(code === 0 ? "PASS" : code === 2 ? "Some criteria are not met, not proven or have no test, or exploration found a new violation" : "The check failed to run");
  return { code, report: checked.report, spec };
}
