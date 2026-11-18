// Writes acceptance tests from a pull request description with a Claude Code agent,
// then checks them independently with a separate verify run.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCriteria } from "./criteria.mjs";
import { findProjectRoot, loadConfig, readNotes } from "./config.mjs";
import { verify } from "./verify.mjs";

const BIN = fileURLToPath(new URL("../bin/acceptance-check.mjs", import.meta.url));
const SKILL = fileURLToPath(new URL("../skill/verify-acceptance/SKILL.md", import.meta.url));
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
  const prompt = readFileSync(PROMPT, "utf8")
    .replaceAll("{{SPEC}}", spec)
    .replaceAll("{{BASE}}", base)
    .replaceAll("{{SKILL}}", inProject(SKILL))
    .replaceAll("{{CHECK}}", check)
    .replaceAll("{{MAX_RUNS}}", options.maxRuns ?? "4")
    .replaceAll("{{APP_NOTES}}", readNotes(root, config))
    .replaceAll("{{CRITERIA}}", criteria.map((criterion) => `- ${criterion}`).join("\n"));
  writeFileSync(join(runDir, "prompt.md"), prompt);

  // The default permission mode refuses anything not allowed here, without
  // prompting. File writes are limited to the spec folder. Shell commands that
  // write files are refused; Claude Code still allows read-only ones such as cat.
  // acceptEdits must not be used: it lets shell commands such as sed -i through.
  const tools = ["Read", "Glob", "Grep", `Write(${config.specDir}/**)`, `Edit(${config.specDir}/**)`,
    `Bash(${checkPrefix}:*)`, "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];
  const agentArgs = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "default",
    "--max-budget-usd", options.maxBudgetUsd ?? "8", "--allowedTools", ...tools, ...(options.model ? ["--model", options.model] : [])];
  log("Agent is writing the tests");
  const agent = await new Promise((done) => {
    const child = spawn(options.agent ?? "claude", agentArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const file = createWriteStream(join(runDir, "agent.jsonl"));
    child.stdout.pipe(file, { end: false });
    child.stderr.pipe(file, { end: false });
    child.once("error", (error) => { file.end(); done({ code: 127, error }); });
    child.once("close", (code) => { file.end(); done({ code: code ?? 1 }); });
  });
  if (agent.error) throw new WriteError(`Could not start the agent: ${agent.error.message}. Install Claude Code (npm i -g @anthropic-ai/claude-code).`);

  const events = readFileSync(join(runDir, "agent.jsonl"), "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast((event) => event.type === "result");
  const notes = (result?.result ?? "").trim();
  writeFileSync(join(runDir, "agent-notes.md"), `${notes}\n`);
  log(`Agent finished: ${result?.subtype ?? `exit ${agent.code}`}, ${result?.num_turns ?? "?"} turns, $${(result?.total_cost_usd ?? 0).toFixed(2)}`);

  const outside = changedPaths().filter((path) => path !== spec);
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
  }
  if (outputFile && checked.report) appendFileSync(outputFile, `report=${checked.report}\nspec=${spec}\n`);
  log(checked.code === 0 ? "PASS" : checked.code === 2 ? "Some criteria are not met, not proven or have no test" : "The check failed to run");
  return { code: checked.code, report: checked.report, spec };
}
