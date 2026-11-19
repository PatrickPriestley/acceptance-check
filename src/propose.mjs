// Proposes acceptance criteria for a change that has none. A read-only agent reads
// the diff and the app code; a person decides whether to use what it proposes.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.mjs";
import { findProjectRoot, loadConfig, readNotes } from "./config.mjs";
import { parseCriteria } from "./criteria.mjs";

const PROMPT = fileURLToPath(new URL("./propose-prompt.md", import.meta.url));
export const PROPOSAL_MARKER = "<!-- acceptance-proposal -->";
const log = (message) => console.log(`[acceptance-check propose] ${message}`);

/**
 * @param {{ cwd?: string, base?: string, model?: string, maxBudgetUsd?: string, agent?: string }} options
 * @returns {Promise<{ code: number, proposal: string | null, criteria: string[] }>}
 *   code 0 with a proposal, 3 when the change touches no app source or the agent finds no visible change, 1 on error.
 */
export async function propose(options) {
  try {
    return await run(options);
  } catch (error) {
    console.error(`[acceptance-check propose] ${error.message}`);
    return { code: 1, proposal: null, criteria: [] };
  }
}

async function run(options) {
  const root = findProjectRoot(resolve(options.cwd ?? process.cwd()));
  const config = await loadConfig(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const base = git("rev-parse", "--verify", `${options.base ?? "origin/main"}^{commit}`).trim();
  const files = git("diff", "--name-only", "--relative", `${base}...HEAD`, "--", ...config.sources).split("\n").filter(Boolean);
  if (!files.length) {
    log(`No file in ${config.sources.join(", ")} changed since ${base.slice(0, 7)}, so there is nothing to propose.`);
    return { code: 3, proposal: null, criteria: [] };
  }

  const runDir = join(root, config.outputDir, "proposals", `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const prompt = readFileSync(PROMPT, "utf8")
    .replaceAll("{{BASE}}", base)
    .replaceAll("{{FILES}}", files.slice(0, 40).map((file) => `\`${file}\``).join(", ") + (files.length > 40 ? ` and ${files.length - 40} more` : ""))
    .replaceAll("{{SPEC_DIR}}", config.specDir)
    .replaceAll("{{APP_NOTES}}", readNotes(root, config));
  // Read-only: no Write or Edit, and only git commands that read history.
  const tools = ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];
  log(`Agent is reading ${files.length} changed ${files.length === 1 ? "file" : "files"}`);
  const { notes } = await runAgent({ root, runDir, prompt, tools, model: options.model, maxBudgetUsd: options.maxBudgetUsd ?? "2", agent: options.agent, log });

  const none = notes.match(/NO VISIBLE CHANGE:\s*(.+)/);
  const criteria = parseCriteria(notes);
  if (!criteria.length) {
    if (none) {
      log(`No visible change: ${none[1].trim()}`);
      return { code: 3, proposal: null, criteria: [] };
    }
    throw new Error(`The agent proposed no criteria. Its notes are in ${relative(root, join(runDir, "agent-notes.md"))}`);
  }
  const why = notes.match(/^#{1,6}\s*why these\s*$([\s\S]*)/im)?.[1].trim();
  const proposal = join(runDir, "proposal.md");
  writeFileSync(proposal, [
    PROPOSAL_MARKER,
    "## Proposed acceptance criteria",
    "",
    "This pull request changes the app but its description has no `## Acceptance criteria` list. An agent read the diff and proposes these. Edit them as you see fit, then paste them into the description:",
    "",
    "```markdown",
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion) => `- ${criterion}`),
    "```",
    "",
    ...(why ? ["<details><summary>Why these</summary>", "", why, "", "</details>", ""] : []),
    "Once the list is in the description, tests can be written from it and checked against the base.",
    "",
  ].join("\n"));
  log(`${criteria.length} criteria proposed. ${relative(root, proposal)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `proposal=${proposal}\n`);
  return { code: 0, proposal, criteria };
}
