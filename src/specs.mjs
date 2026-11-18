// Chooses which specs a pull request run checks: the ones it adds or changes,
// or, when asked, every spec when it changed none.
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { findProjectRoot, loadConfig } from "./config.mjs";

const isSpec = (path) => path.endsWith(".spec.ts");

export async function listSpecs({ cwd = process.cwd(), base, allWhenNone = false }) {
  if (!base) throw new Error("specs needs --base=<ref>");
  const here = resolve(cwd);
  const root = findProjectRoot(here);
  const config = await loadConfig(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  let specs = git("diff", "--name-only", "--relative", "--diff-filter=AM", base, "HEAD", "--", config.specDir).filter(isSpec);
  let changed = true;
  if (specs.length === 0 && allWhenNone) {
    specs = git("ls-files", "--", config.specDir).filter(isSpec);
    changed = false;
  }
  return { changed, specs: specs.sort().map((path) => relative(here, join(root, path))) };
}
