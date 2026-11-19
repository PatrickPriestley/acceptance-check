// Runs one Claude Code agent in print mode and reads its final result. Shared by
// every command that hands work to an agent; each passes its own tools and prompt.
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export class AgentError extends Error {}

/**
 * The default permission mode refuses anything not in `tools`, without prompting.
 * acceptEdits must never be used: it lets shell commands such as sed -i through.
 * @param {{ root: string, runDir: string, prompt: string, tools: string[], model?: string, maxBudgetUsd?: string, agent?: string, log: (message: string) => void }} options
 * @returns {Promise<{ result: any, notes: string }>} Throws AgentError when the agent could not run.
 */
export async function runAgent({ root, runDir, prompt, tools, model, maxBudgetUsd, agent: program, log }) {
  writeFileSync(join(runDir, "prompt.md"), prompt);
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "default",
    "--max-budget-usd", maxBudgetUsd ?? "8", "--allowedTools", ...tools, ...(model ? ["--model", model] : [])];
  const agent = await new Promise((done) => {
    const child = spawn(program ?? "claude", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const file = createWriteStream(join(runDir, "agent.jsonl"));
    child.stdout.pipe(file, { end: false });
    child.stderr.pipe(file, { end: false });
    child.once("error", (error) => { file.end(); done({ code: 127, error }); });
    child.once("close", (code) => { file.end(); done({ code: code ?? 1 }); });
  });
  if (agent.error) throw new AgentError(`Could not start the agent: ${agent.error.message}. Install Claude Code (npm i -g @anthropic-ai/claude-code).`);

  const events = readFileSync(join(runDir, "agent.jsonl"), "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast((event) => event.type === "result");
  const notes = (result?.result ?? "").trim();
  writeFileSync(join(runDir, "agent-notes.md"), `${notes}\n`);
  log(`Agent finished: ${result?.subtype ?? `exit ${agent.code}`}, ${result?.num_turns ?? "?"} turns, $${(result?.total_cost_usd ?? 0).toFixed(2)}`);
  // An agent that could not start work (no API key, no credit, a bad model name)
  // still ends with a result event, so report its own words.
  if (!result || result.is_error || agent.code !== 0) {
    throw new AgentError(`The agent did not run: ${notes || `exit ${agent.code}`}. Its log is in ${relative(root, join(runDir, "agent.jsonl"))}`);
  }
  return { result, notes };
}
