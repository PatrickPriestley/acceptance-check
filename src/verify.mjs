// Checks acceptance criteria in a real browser against this checkout and against a base revision.
// How the app builds and starts comes from acceptance.config.mjs; nothing here is app-specific.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { normalizeCriterion } from "./criteria.mjs";
import { expandEnv, findProjectRoot, loadConfig } from "./config.mjs";
import { verdict } from "./verdicts.mjs";

const BUILT_IN_PLAYWRIGHT_CONFIG = fileURLToPath(new URL("./playwright.config.mjs", import.meta.url));
const log = (message) => console.log(`[acceptance-check] ${message}`);

/**
 * @param {{ cwd?: string, base?: string, skipBuild?: boolean, criteria?: string, prepareOnly?: boolean, breaks?: boolean, specs: string[] }} options
 * @returns {Promise<{ code: number, report: string | null }>} code 0 when every criterion is met or still holds
 *   and every named break is caught, 2 when not, 1 when the check itself failed; report is the path of report.md
 *   when one was written. `breaks: false` skips the break check.
 */
export async function verify(options) {
  const root = findProjectRoot(resolve(options.cwd ?? process.cwd()));
  const config = await loadConfig(root);
  const output = join(root, config.outputDir);
  const run = join(output, "runs", `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`);
  const baseCache = join(output, "bases");
  const shown = (path) => relative(root, path);
  /** @type {Set<import("node:child_process").ChildProcess & { exited: Promise<number> }>} */
  const children = new Set();
  let reportFile = null;

  function exec(command, args, { cwd = root, env = process.env, logFile, echo = false } = {}) {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const file = logFile && createWriteStream(logFile, { flags: "a" });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        file?.write(chunk);
        if (echo || !logFile) process.stdout.write(chunk);
      });
    }
    child.exited = new Promise((done) => {
      child.once("error", (error) => { console.error(error.message); done(127); });
      child.once("close", (code, signal) => { children.delete(child); file?.end(); done(code ?? (signal ? 1 : 0)); });
    });
    return child;
  }

  async function step(name, [command, ...args], extra = {}) {
    log(name);
    const code = await exec(command, args, extra).exited;
    if (code !== 0) throw new Error(`${name} failed with exit code ${code}${extra.logFile ? `. See ${shown(extra.logFile)}` : ""}`);
  }

  async function stopAll() {
    const pending = [...children];
    for (const child of pending) child.kill("SIGTERM");
    await Promise.race([Promise.all(pending.map((child) => child.exited)), delay(5000)]);
    for (const child of pending) child.kill("SIGKILL");
  }

  const onSignal = (signal, code) => async () => {
    await stopAll();
    log(`Interrupted by ${signal}. Evidence kept in ${shown(run)}`);
    process.exit(code);
  };
  const handlers = [["SIGINT", onSignal("SIGINT", 130)], ["SIGTERM", onSignal("SIGTERM", 143)]];
  for (const [signal, handler] of handlers) process.on(signal, handler);

  async function freePort() {
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
    await new Promise((done) => probe.close(done));
    return port;
  }

  // The app gets only the allowlisted variables plus the configured ones, with a
  // free port and a fresh data folder for each side.
  async function startApp(side, appRoot) {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const data = join(run, side, "data");
    mkdirSync(data, { recursive: true });
    const passed = Object.fromEntries(config.start.allowEnv.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
    const env = { ...passed, ...expandEnv(config.start.env, { port, data }) };
    const [command, ...args] = config.start.command;
    const app = exec(command === "node" ? process.execPath : command, args, { cwd: appRoot, env, logFile: join(run, side, "app.log") });
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        if ((await fetch(`${origin}${config.start.health}`)).ok) return { app, origin };
      } catch {}
      if (app.exitCode !== null) throw new Error(`The ${side} app exited before becoming healthy. See ${shown(join(run, side, "app.log"))}`);
      await delay(100);
    }
    throw new Error(`The ${side} app was not healthy after 30s. See ${shown(join(run, side, "app.log"))}`);
  }

  // The project's own Playwright, so the specs and the runner use one version.
  function playwrightCli() {
    for (const from of [join(root, "package.json"), fileURLToPath(import.meta.url)]) {
      try {
        return createRequire(from).resolve("@playwright/test/cli");
      } catch {}
    }
    throw new Error("Cannot find @playwright/test. Add it to the project's devDependencies.");
  }

  async function checkSide(side, appRoot, specs = options.specs) {
    mkdirSync(join(run, side), { recursive: true });
    const { app, origin } = await startApp(side, appRoot);
    log(`Checking criteria on ${side} at ${origin}`);
    const report = join(run, side, "report.json");
    const playwrightConfig = config.playwrightConfig ? join(root, config.playwrightConfig) : BUILT_IN_PLAYWRIGHT_CONFIG;
    const code = await exec(process.execPath, [playwrightCli(), "test", "--config", playwrightConfig, ...specs], {
      env: {
        ...process.env,
        ACCEPTANCE_BASE_URL: origin,
        ACCEPTANCE_OUTPUT: join(run, side, "results"),
        ACCEPTANCE_REPORT: report,
        ACCEPTANCE_SPEC_DIR: join(root, config.specDir),
      },
      logFile: join(run, side, "playwright.log"),
      echo: true,
    }).exited;
    app.kill("SIGTERM");
    await app.exited;
    if (!existsSync(report)) throw new Error(`Playwright wrote no report on ${side} (exit ${code}). See ${shown(join(run, side, "playwright.log"))}`);
    return parseReport(report);
  }

  // The break check. A @holds test passes on both sides by design, so the comparison
  // with the base cannot show that it would ever fail. Each such test names a break
  // from the config; the break is applied to a copy of this change, which is built
  // and checked again. The test must fail there.
  async function checkBreaks(headResults) {
    const claims = [...headResults.values()].filter((test) => test.kind === "holds" && test.passed && test.catches.length);
    if (options.breaks === false || !claims.length) return [];
    const known = new Map(config.breaks.map((item) => [item.name, item]));
    const rows = [];
    let tree;
    for (const name of [...new Set(claims.flatMap((test) => test.catches))]) {
      const tests = claims.filter((test) => test.catches.includes(name));
      const fault = known.get(name);
      if (!fault) {
        rows.push(...tests.map((test) => ({ test, name, outcome: "unknown" })));
        continue;
      }
      tree ??= await prepareBreakTree();
      const file = join(tree, fault.file);
      const original = readFileSync(file, "utf8");
      const found = original.split(fault.find).length - 1;
      if (found !== 1) throw new Error(`Break ${name}: ${fault.file} must contain its find text exactly once, but contains it ${found} times. Update breaks in acceptance.config.mjs.`);
      writeFileSync(file, original.replace(fault.find, () => fault.replace));
      let results;
      try {
        await step(`Building with break ${name}`, config.build, { cwd: tree, logFile: join(run, "breaks", `${name}-build.log`) });
        results = await checkSide(`break-${name}`, tree, [...new Set(tests.map((test) => join(config.specDir, test.file)))]);
      } finally {
        writeFileSync(file, original);
      }
      for (const test of tests) {
        const result = results.get(`${test.file}::${test.title}`);
        const outcome = !result ? "missing" : result.skipped ? "skipped" : result.passed ? "weak" : "caught";
        rows.push({ test, name, outcome, error: result?.error ?? "" });
      }
    }
    return rows;
  }

  // One exported copy of this change, uncommitted edits to tracked files included,
  // with its own dependencies. Each break edits, builds and restores it in turn.
  async function prepareBreakTree() {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: root, encoding: "utf8" }).trim();
    const snapshot = execFileSync("git", ["stash", "create"], { cwd: root, encoding: "utf8" }).trim() || "HEAD";
    const tree = join(run, "breaks", "tree");
    const buildLog = join(run, "breaks", "install.log");
    mkdirSync(tree, { recursive: true });
    await step("Copying this change for the break check", ["sh", "-c", `git -C "$(git rev-parse --show-toplevel)" archive ${snapshot} | tar -x -C "${tree}"`], { logFile: buildLog });
    await step("Installing dependencies for the break check", config.install, { cwd: join(tree, prefix), logFile: buildLog });
    return join(tree, prefix);
  }

  function writeReport(baseSha, headResults, baseResults, baseError, criteria, breakRows) {
    const rows = reportRows(headResults, baseResults, criteria);
    const status = (side) => (side ? (side.skipped ? "Skipped" : side.passed ? "Pass" : "Fail") : "Not run");
    const icon = (v) => (v.warn ? "⚠️" : v.ok ? "✅" : "❌");
    const lines = [
      "<!-- acceptance-agent -->",
      "## Acceptance criteria",
      "",
      `Each criterion ran in a real browser against this change and against the base \`${baseSha.slice(0, 7)}\`${config.report.setting ? `, ${config.report.setting}` : ""}. A new criterion is met only when it fails on the base and passes here.`,
      "",
      "| Criterion | Kind | Base | This change | Verdict |",
      "|---|---|---|---|---|",
      ...rows.map((row) => `| ${cell(row.title)} | ${row.kind === "new" ? "New" : row.kind === "holds" ? "Must still hold" : row.file ? "Untagged" : ""} | ${status(row.base)} | ${row.file ? status(row) : "No test"} | ${icon(row.verdict)} ${row.verdict.label} |`),
      "",
    ];
    if (baseError) lines.push(`The base could not run: ${cell(baseError)}`, "");
    lines.push(
      "**Evidence.** Video, Playwright trace and a final screenshot for every criterion on both sides are in the [run artifact]({{ARTIFACT_URL}}). Open a `trace.zip` at https://trace.playwright.dev.",
      "",
      "<details><summary>Details per criterion</summary>",
      "",
    );
    for (const row of rows.filter((item) => item.file)) {
      lines.push(`**${cell(row.title)}** (\`${row.file}\`)`, "");
      for (const [side, result] of [["Base", row.base], ["This change", row]]) {
        if (!result) continue;
        const folder = result.evidence && relative(run, dirname(result.evidence));
        lines.push(`- ${side}: ${status(result)}${result.error ? `. ${cell(result.error)}` : ""}${folder ? `. Evidence in \`${folder}/\`` : ""}`);
      }
      lines.push("");
    }
    lines.push(
      "</details>",
      "",
      [criteria ? "Every criterion in the pull request description is listed above." : "Only the criteria above were checked.", config.report.limits]
        .filter(Boolean).join(" "),
    );
    const unclaimed = config.breaks.length && options.breaks !== false
      ? rows.filter((row) => row.kind === "holds" && row.passed && !row.catches.length)
      : [];
    if (breakRows.length || unclaimed.length) {
      lines.push(
        "",
        "### Break check",
        "",
        "A `@holds` test passes on both sides, so the comparison above cannot show it would ever fail. Each one names a break from the config; the break was applied to a copy of this change, and the test must fail there.",
        "",
      );
      if (breakRows.length) {
        lines.push("| Test | Break | With the break | Result |", "|---|---|---|---|");
        for (const row of breakRows) {
          const result = BREAK_OUTCOMES[row.outcome];
          lines.push(`| ${cell(row.test.title)} | \`${row.name}\` | ${result.status} | ${result.ok ? "✅" : "❌"} ${result.label} |`);
        }
        lines.push("");
      }
      if (unclaimed.length) lines.push(`${unclaimed.length} \`@holds\` ${unclaimed.length === 1 ? "test names" : "tests name"} no break, so ${unclaimed.length === 1 ? "it was" : "they were"} not checked this way: ${unclaimed.map((row) => cell(row.title)).join("; ")}.`, "");
    }
    reportFile = join(run, "report.md");
    writeFileSync(reportFile, `${lines.join("\n")}\n`);
    writeFileSync(join(run, "report.json"), JSON.stringify({
      base: baseSha,
      criteria: rows.map(({ verdict: v, ...row }) => ({ ...row, verdict: v.label, ok: v.ok })),
      breaks: breakRows.map((row) => ({ title: row.test.title, file: row.test.file, break: row.name, outcome: row.outcome, ok: BREAK_OUTCOMES[row.outcome].ok })),
    }, null, 2));
    return rows;
  }

  function validateBuild() {
    const outputs = config.buildOutputs.map((path) => join(root, path));
    const missing = outputs.filter((path) => !existsSync(path));
    if (missing.length) throw new Error(`--skip-build needs an existing build; missing ${missing.map(shown).join(", ")}`);
    const built = Math.min(...outputs.map((path) => statSync(path).mtimeMs));
    const changed = execFileSync("git", ["ls-files", "-m", "-o", "--exclude-standard", "--", ...config.sources], { cwd: root, encoding: "utf8" })
      .split("\n").filter(Boolean).filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).mtimeMs > built);
    if (changed.length) throw new Error(`--skip-build refused: ${changed[0]} is newer than the build. Run without --skip-build.`);
  }

  // Each base revision is exported once to <outputDir>/bases/<sha>/ and reused, so
  // repeated runs (an agent iterating on a spec) skip the base build. A build goes
  // to a temporary folder first, so a half-built base is never reused. When the app
  // is in a subfolder of its repository, the base uses the same subfolder.
  async function prepareBase(sha) {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: root, encoding: "utf8" }).trim();
    const ready = join(baseCache, sha, ".ready");
    if (existsSync(ready)) {
      log(`Reusing base build ${sha.slice(0, 7)}`);
      utimesSync(ready, new Date(), new Date());
      return join(baseCache, sha, prefix);
    }
    const building = join(baseCache, `${sha}.${process.pid}.tmp`);
    const buildLog = join(run, "base-build.log");
    mkdirSync(building, { recursive: true });
    try {
      await step(`Exporting base ${sha.slice(0, 7)}`, ["sh", "-c", `git -C "$(git rev-parse --show-toplevel)" archive ${sha} | tar -x -C "${building}"`], { logFile: buildLog });
      await step("Installing base dependencies", config.install, { cwd: join(building, prefix), logFile: buildLog });
      await step("Building base", config.build, { cwd: join(building, prefix), logFile: buildLog });
      writeFileSync(join(building, ".ready"), "");
      try { renameSync(building, join(baseCache, sha)); } catch { rmSync(building, { recursive: true, force: true }); }
    } catch (error) {
      rmSync(building, { recursive: true, force: true });
      throw error;
    }
    pruneBases(sha);
    return join(baseCache, sha, prefix);
  }

  function pruneBases(keep) {
    const bases = readdirSync(baseCache)
      .filter((name) => /^[0-9a-f]{40}$/.test(name) && name !== keep && existsSync(join(baseCache, name, ".ready")))
      .sort((a, b) => statSync(join(baseCache, b, ".ready")).mtimeMs - statSync(join(baseCache, a, ".ready")).mtimeMs);
    for (const name of bases.slice(2)) rmSync(join(baseCache, name), { recursive: true, force: true });
  }

  async function main() {
    if (!options.specs.length && !options.prepareOnly) throw new Error("Name at least one spec file.");
    for (const spec of options.specs) if (!existsSync(resolve(root, spec))) throw new Error(`No such spec: ${spec}`);
    mkdirSync(run, { recursive: true });
    log(`Run folder ${shown(run)}`);

    const baseSha = execFileSync("git", ["rev-parse", "--verify", `${options.base ?? "origin/main"}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
    const criteria = options.criteria ? JSON.parse(readFileSync(resolve(options.criteria), "utf8")).map(normalizeCriterion) : undefined;

    if (options.skipBuild) validateBuild();
    else await step("Building this change", config.build, { logFile: join(run, "head-build.log") });

    let baseError;
    let baseTree;
    try {
      baseTree = await prepareBase(baseSha);
      if (options.prepareOnly) return 0;
    } catch (error) {
      if (options.prepareOnly) throw error;
      baseError = error.message;
      log(`Base unavailable: ${baseError}`);
    }

    const headResults = await checkSide("head", root);
    const baseResults = baseError ? undefined : await checkSide("base", baseTree);
    const breakRows = await checkBreaks(headResults);
    const rows = writeReport(baseSha, headResults, baseResults, baseError, criteria, breakRows);

    console.log("");
    for (const row of rows) console.log(`  ${row.verdict.warn ? "WARN" : row.verdict.ok ? "OK  " : "FAIL"}  ${row.verdict.label.padEnd(32)} ${row.title}`);
    for (const row of breakRows) {
      const result = BREAK_OUTCOMES[row.outcome];
      console.log(`  ${result.ok ? "OK  " : "FAIL"}  ${`${result.label} (${row.name})`.padEnd(32)} ${row.test.title}`);
    }
    console.log("");
    log(`Report ${shown(join(run, "report.md"))}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `report=${join(run, "report.md")}\nrun=${run}\n`);
    const breaksOk = breakRows.every((row) => BREAK_OUTCOMES[row.outcome].ok);
    return rows.length && rows.every((row) => row.verdict.ok) && breaksOk ? 0 : 2;
  }

  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error(`[acceptance-check] ${error.message}`);
  }
  await stopAll();
  for (const [signal, handler] of handlers) process.off(signal, handler);
  log(code === 0 && options.prepareOnly ? "Builds ready." : code === 0 ? "PASS: every criterion met or still holds." : code === 2 ? "FAIL: at least one criterion is not met or not proven, or a break was not caught." : `ERROR. Evidence kept in ${shown(run)}`);
  return { code, report: reportFile };
}

// The assertion and what it expected or found, without the call log.
export function summarizeError(text = "") {
  const lines = text.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  return [...new Set([lines[0], ...lines.filter((line) => /^(Locator|Expected|Received|Error):/.test(line))])].filter(Boolean).slice(0, 4).join(". ");
}

/** Reads a Playwright JSON report into one result per test, keyed by file and title. */
export function parseReport(file) {
  const results = new Map();
  const walk = (suite, specFile) => {
    for (const spec of suite.specs ?? []) {
      const test = spec.tests.at(-1);
      const result = test?.results.at(-1);
      const attachment = (name) => result?.attachments.find((item) => item.name === name && item.path)?.path;
      const tags = [...(spec.tags ?? []), ...(test?.tags ?? [])].map((tag) => tag.replace(/^@/, ""));
      const annotations = [...(test?.annotations ?? []), ...(result?.annotations ?? [])];
      results.set(`${specFile}::${spec.title}`, {
        file: specFile,
        title: spec.title,
        kind: tags.includes("new") ? "new" : tags.includes("holds") ? "holds" : null,
        passed: test?.status === "expected" && result?.status === "passed",
        skipped: test?.status === "skipped",
        unverifiable: annotations.find((item) => item.type === "unverifiable")?.description ?? null,
        catches: [...new Set(annotations.filter((item) => item.type === "catches" && item.description).map((item) => item.description.trim()))],
        error: summarizeError(result?.error?.message),
        evidence: attachment("video") ?? attachment("trace") ?? attachment("screenshot"),
      });
    }
    for (const child of suite.suites ?? []) walk(child, specFile);
  };
  for (const suite of JSON.parse(readFileSync(file, "utf8")).suites ?? []) walk(suite, suite.file ?? suite.title);
  return results;
}

// With a criteria list, every criterion gets a row in its own order, even when no
// test matches it. Tests beyond the list keep their rows after it.
export function reportRows(headResults, baseResults, criteria) {
  const tests = [...headResults.values()];
  const row = (head) => {
    const base = baseResults?.get(`${head.file}::${head.title}`);
    return { ...head, base, verdict: verdict(head.kind, head, base) };
  };
  return criteria
    ? [
        ...criteria.map((title) => {
          const head = tests.find((test) => normalizeCriterion(test.title) === title);
          return head ? row(head) : { title, file: null, kind: null, verdict: verdict(null, null, null) };
        }),
        ...tests.filter((test) => !criteria.includes(normalizeCriterion(test.title))).map(row),
      ]
    : tests.map(row);
}

/** How a @holds test fared with the break it names. */
export const BREAK_OUTCOMES = {
  caught: { ok: true, status: "Fail", label: "Caught" },
  weak: { ok: false, status: "Pass", label: "Weak: still passes with the break" },
  skipped: { ok: false, status: "Skipped", label: "Not checked: skipped with the break" },
  missing: { ok: false, status: "Not run", label: "Not checked: did not run with the break" },
  unknown: { ok: false, status: "Not run", label: "Unknown break: not in the config" },
};

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
