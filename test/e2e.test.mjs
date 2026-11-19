// Runs the real command against the example app in a throwaway repository with two
// commits: the app before the fix, and after it. Needs Chromium for Playwright.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = join(packageRoot, "bin/acceptance-check.mjs");
// Inside the package, so the specs resolve @playwright/test from its node_modules.
const project = join(packageRoot, "test/.tmp", `e2e-${process.pid}`);
const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: project, encoding: "utf8" }).trim();
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: project, encoding: "utf8", timeout: 240_000 });
const server = join(project, "app/server.mjs");
let before_, after_;

before(() => {
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  cpSync(join(packageRoot, "example"), project, { recursive: true });
  writeFileSync(join(project, ".gitignore"), ".acceptance/\n");
  const fixed = readFileSync(server, "utf8");
  writeFileSync(server, fixed.replace("const REJECT_BLANK = true;", "const REJECT_BLANK = false;"));
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "before the fix");
  before_ = git("rev-parse", "HEAD");
  writeFileSync(server, fixed);
  git("commit", "-q", "-am", "reject blank names");
  after_ = git("rev-parse", "HEAD");
});

after(() => rmSync(project, { recursive: true, force: true }));

const report = (output) => {
  const path = output.match(/Report (\S+report\.md)/)?.[1];
  assert.ok(path, `a report was written:\n${output}`);
  return readFileSync(join(project, path), "utf8");
};

test("a fix is met against the base before it, and the other criterion still holds", () => {
  const run = cli("verify", `--base=${before_}`, "tests/blank-name.spec.ts");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const md = report(run.stdout);
  assert.match(md, /A blank name shows "Enter a name for the item\." and saves nothing \| New \| Fail \| Pass \| ✅ Met/);
  assert.match(md, /A real name is trimmed and added to the list \| Must still hold \| Pass \| Pass \| ✅ Still holds/);
  assert.match(md, new RegExp(`base \`${before_.slice(0, 7)}\`, with an empty list`));
  assert.match(md, /### Break check/);
  assert.match(md, /\| A real name is trimmed and added to the list \| `items-not-saved` \| Fail \| ✅ Caught \|/);
  const run2 = run.stdout.match(/Run folder (\S+)/)[1];
  assert.ok(existsSync(join(project, run2, "head/results")), "evidence was kept");
});

test("a test that also passes on the base is reported as not proven", () => {
  const run = cli("verify", `--base=${after_}`, "--skip-build", "tests/blank-name.spec.ts");
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(report(run.stdout), /❌ Not proven: also passes on base/);
});

test("a @holds test that still passes with its break, or names an unknown break, fails the run", () => {
  const spec = join(project, "tests", "weak.spec.ts");
  writeFileSync(spec, `import { test, expect } from "./fixtures";
test("The page shows a heading", { tag: "@holds", annotation: { type: "catches", description: "items-not-saved" } }, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
});
test("The page shows an Add button", { tag: "@holds", annotation: { type: "catches", description: "no-such-break" } }, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
});
`);
  try {
    const run = cli("verify", `--base=${before_}`, "--skip-build", "tests/weak.spec.ts");
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const md = report(run.stdout);
    assert.match(md, /\| The page shows a heading \| Must still hold \| Pass \| Pass \| ✅ Still holds \|/);
    assert.match(md, /\| The page shows a heading \| `items-not-saved` \| Pass \| ❌ Weak: still passes with the break \|/);
    assert.match(md, /\| The page shows an Add button \| `no-such-break` \| Not run \| ❌ Unknown break: not in the config \|/);
    const skipped = cli("verify", `--base=${before_}`, "--skip-build", "--no-breaks", "tests/weak.spec.ts");
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
    assert.doesNotMatch(report(skipped.stdout), /Break check/);
  } finally {
    rmSync(spec, { force: true });
  }
});

test("a criterion without a test is reported, and the base build is reused", () => {
  const criteria = join(project, ".acceptance", "criteria.json");
  mkdirSync(join(project, ".acceptance"), { recursive: true });
  writeFileSync(criteria, JSON.stringify(['A blank name shows "Enter a name for the item." and saves nothing', "The list shows how many items there are"]));
  const run = cli("verify", `--base=${before_}`, "--skip-build", `--criteria=${criteria}`, "tests/blank-name.spec.ts");
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /Reusing base build/);
  const md = report(run.stdout);
  assert.match(md, /The list shows how many items there are \|  \| Not run \| No test \| ❌ No test written/);
  assert.match(md, /Every criterion in the pull request description is listed above\./);
});

test("specs lists the changed specs, and every spec only when asked and none changed", () => {
  const lines = (run) => {
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return run.stdout.split("\n").filter(Boolean);
  };
  // The second commit changes the app, not a spec.
  assert.deepEqual(lines(cli("specs", `--base=${before_}`)), []);
  const all = cli("specs", `--base=${before_}`, "--all-when-none");
  assert.deepEqual(lines(all), ["tests/blank-name.spec.ts", "tests/item-count.spec.ts"]);
  assert.match(all.stderr, /No spec changed since .*; checking all 2\./);
  // Against the empty tree every spec is new, so --all-when-none changes nothing.
  const emptyTree = git("hash-object", "-t", "tree", "/dev/null");
  const added = cli("specs", `--base=${emptyTree}`, "--all-when-none");
  assert.deepEqual(lines(added), ["tests/blank-name.spec.ts", "tests/item-count.spec.ts"]);
  assert.equal(added.stderr, "");
  assert.equal(cli("specs").status, 1);
});

test("an agent that could not run is reported with its own words, not as a missing spec", () => {
  // Claude Code without a usable key still ends with a result event, marked as an error.
  const dir = join(project, ".acceptance");
  mkdirSync(dir, { recursive: true });
  const agent = join(dir, "fake-agent.mjs");
  writeFileSync(agent, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 1, total_cost_usd: 0, result: "Invalid API key · Please run /login" }));
`);
  chmodSync(agent, 0o755);
  writeFileSync(join(dir, "body.md"), "## Acceptance criteria\n\n- The list shows how many items there are\n");
  const script = `import { write } from ${JSON.stringify(join(packageRoot, "src/write.mjs"))};
const r = await write({ body: ".acceptance/body.md", spec: "tests/pr-1.spec.ts", base: ${JSON.stringify(before_)}, agent: ${JSON.stringify(agent)} });
process.exitCode = r.code;`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: project, encoding: "utf8", timeout: 240_000 });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /The agent did not run: Invalid API key · Please run \/login\. Its log is in \.acceptance\/agent\/.+\/agent\.jsonl/);
  assert.doesNotMatch(run.stderr, /wrote no spec/);
});

test("a missing config gives a clear error and init writes the starting files", () => {
  const empty = join(project, "..", `init-${process.pid}`);
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty);
  const verify = spawnSync(process.execPath, [bin, "verify", "x.spec.ts"], { cwd: empty, encoding: "utf8" });
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /No acceptance\.config\.mjs .*Run `acceptance-check init`/);
  const init = spawnSync(process.execPath, [bin, "init"], { cwd: empty, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  for (const file of ["acceptance.config.mjs", "docs/acceptance-notes.md", "tests/acceptance/fixtures.ts"]) assert.ok(existsSync(join(empty, file)), file);
  rmSync(empty, { recursive: true, force: true });
});
