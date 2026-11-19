import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { commentBody, MARKER, postComment } from "../src/comment.mjs";
import { expandEnv, validateConfig } from "../src/config.mjs";
import { normalizeCriterion, parseCriteria } from "../src/criteria.mjs";
import { verdict, VERDICTS } from "../src/verdicts.mjs";
import { reportRows, summarizeError } from "../src/verify.mjs";

test("criteria are read from the first Acceptance criteria section only", () => {
  const body = [
    "## Why", "- not a criterion", "",
    "## Acceptance criteria", "",
    "- [ ] A blank name shows “Enter a name”", "- [x] Checked items count too", "* A star item",
    "1. A numbered item", "  that wraps", "<!-- - a hidden item -->", "Some prose.", "",
    "## Verification", "- not a criterion either",
  ].join("\n");
  assert.deepEqual(parseCriteria(body), [
    'A blank name shows "Enter a name"',
    "Checked items count too",
    "A star item",
    "A numbered item that wraps",
  ]);
  assert.deepEqual(parseCriteria("## Why\nNo criteria here"), []);
  assert.equal(normalizeCriterion("  it’s   “quoted” "), `it's "quoted"`);
});

test("a new criterion is met only when it fails on the base and passes on the change", () => {
  const pass = { passed: true };
  const fail = { passed: false };
  assert.equal(verdict("new", pass, fail), VERDICTS.met);
  assert.equal(verdict("new", pass, pass), VERDICTS.notProven);
  assert.equal(verdict("new", fail, fail), VERDICTS.notMet);
  assert.equal(verdict("new", pass, undefined), VERDICTS.noBase);
  assert.equal(verdict("holds", pass, pass), VERDICTS.holds);
  assert.equal(verdict("holds", pass, fail), VERDICTS.holds);
  assert.equal(verdict("holds", fail, pass), VERDICTS.regressed);
  assert.equal(verdict("holds", fail, fail), VERDICTS.notMet);
  assert.equal(verdict(null, pass, pass), VERDICTS.untagged);
  assert.equal(verdict("new", null, null), VERDICTS.noTest);
  assert.equal(verdict("new", { passed: false, skipped: true }, null), VERDICTS.skipped);
  const unverifiable = verdict("new", { passed: false, skipped: true, unverifiable: "needs sign-in" }, null);
  assert.equal(unverifiable.label, "Not verifiable here: needs sign-in");
  assert.equal(unverifiable.ok, true);
  assert.equal(unverifiable.warn, true);
});

test("a config with problems is rejected with every problem listed", () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-config-"));
  assert.throws(
    () => validateConfig(root, { install: "npm ci", build: ["npm"], buildOutputs: [], sources: ["src"], start: { command: ["node"], health: "health" }, specDir: "", notes: "missing.md" }),
    /install must be a command.*buildOutputs must list.*start\.health must be a path.*specDir must be a path.*notes file missing\.md does not exist/,
  );
  assert.throws(() => validateConfig(root, { install: ["", "x"], build: ["node", "-e", ""], buildOutputs: ["a"], sources: ["b"], start: { command: ["node"], health: "/h" }, specDir: "t" }), /install must be a command/);
  writeFileSync(join(root, "notes.md"), "# Notes");
  const config = validateConfig(root, { install: ["npm", "ci"], build: ["npm", "run", "build"], buildOutputs: ["dist/a.js"], sources: ["src"], start: { command: ["node", "dist/a.js"], health: "/health" }, specDir: "tests/acceptance/", notes: "notes.md" });
  assert.equal(config.specDir, "tests/acceptance");
  assert.deepEqual(config.start.allowEnv, ["PATH", "HOME"]);
  assert.equal(config.outputDir, ".acceptance");
  assert.equal(config.playwrightConfig, null);
  assert.deepEqual(config.breaks, []);
});

test("breaks need a unique name, an existing file and different replacement text", () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-breaks-"));
  writeFileSync(join(root, "app.js"), "const a = 1;");
  const base = { install: ["npm", "ci"], build: ["npm", "run", "build"], buildOutputs: ["a"], sources: ["b"], start: { command: ["node"], health: "/h" }, specDir: "t" };
  assert.throws(
    () => validateConfig(root, { ...base, breaks: [
      { name: "Bad Name", file: "app.js", find: "1", replace: "2" },
      { name: "ok", file: "missing.js", find: "", replace: "" },
      { name: "ok", file: "app.js", find: "1", replace: "1" },
    ] }),
    /breaks\[0\]\.name must be a short lowercase name.*breaks\[1\]\.file missing\.js does not exist; breaks\[1\]\.find must be text.*breaks\[2\]\.name ok is used twice; breaks\[2\]\.replace must be different text/,
  );
  const config = validateConfig(root, { ...base, breaks: [{ name: "one-off", file: "app.js", find: "1", replace: "2" }] });
  assert.equal(config.breaks[0].name, "one-off");
});

test("{port} and {data} are filled in per copy", () => {
  assert.deepEqual(expandEnv({ PORT: "{port}", FILE: "{data}/plan.json", MODE: "local" }, { port: 4321, data: "/tmp/x" }), { PORT: "4321", FILE: "/tmp/x/plan.json", MODE: "local" });
});

test("with a criteria list, every criterion gets a row and missing tests are reported", () => {
  const head = new Map([
    ["a.spec.ts::First", { file: "a.spec.ts", title: "First", kind: "new", passed: true }],
    ["a.spec.ts::Extra", { file: "a.spec.ts", title: "Extra", kind: "holds", passed: true }],
  ]);
  const base = new Map([["a.spec.ts::First", { file: "a.spec.ts", title: "First", kind: "new", passed: false }]]);
  const rows = reportRows(head, base, ["First", "Second"]);
  assert.deepEqual(rows.map((row) => [row.title, row.verdict.label]), [
    ["First", "Met"],
    ["Second", "No test written"],
    ["Extra", "Still holds"],
  ]);
});

test("error summaries keep the assertion and drop the call log", () => {
  const message = "\u001b[31mError: expect(locator).toHaveText(expected) failed\u001b[39m\n\nLocator: getByRole('alert')\nExpected: \"x\"\nError: element(s) not found\n\nCall log:\n  - waiting";
  assert.equal(summarizeError(message), "Error: expect(locator).toHaveText(expected) failed. Locator: getByRole('alert'). Expected: \"x\". Error: element(s) not found");
});

test("the comment fills in the artifact link and carries the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-comment-"));
  writeFileSync(join(dir, "report.md"), `${MARKER}\nSee the [artifact]({{ARTIFACT_URL}}).\n`);
  const body = commentBody(join(dir, "report.md"), { ARTIFACT_URL: "https://example.invalid/a", RUN_URL: "https://example.invalid/r" });
  assert.match(body, /^<!-- acceptance-agent -->/);
  assert.match(body, /\(https:\/\/example\.invalid\/a\)/);
  assert.match(commentBody(join(dir, "missing.md"), { RUN_URL: "https://example.invalid/r" }), /did not produce a report/);
});

test("a proposal edits its own comment and leaves the verdicts comment alone", async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push(`${request.method} ${request.url}`);
    const comments = [{ id: 1, body: `${MARKER}\nverdicts` }, { id: 2, body: "<!-- acceptance-proposal -->\nold proposal" }];
    const reply = request.method === "GET" ? comments : { html_url: `comment-${request.url.split("/").at(-1)}` };
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "7", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` };
  try {
    assert.equal(await postComment("<!-- acceptance-proposal -->\nnew proposal", env), "comment-2");
    assert.equal(await postComment(`${MARKER}\nnew verdicts`, env), "comment-1");
    assert.deepEqual(calls.filter((call) => call.startsWith("PATCH")), ["PATCH /repos/o/r/issues/comments/2", "PATCH /repos/o/r/issues/comments/1"]);
  } finally {
    server.close();
  }
});

test("explore needs a command and property files inside specDir", () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-explore-"));
  mkdirSync(join(root, "t"));
  writeFileSync(join(root, "spec.ts"), "");
  writeFileSync(join(root, "t", "props.ts"), "");
  const base = { install: ["npm", "ci"], build: ["npm", "run", "build"], buildOutputs: ["a"], sources: ["b"], start: { command: ["node"], health: "/h" }, specDir: "t" };
  assert.throws(() => validateConfig(root, { ...base, explore: { command: "bombadil", properties: [] } }), /explore\.command must be a command.*explore\.properties must list at least one file/);
  assert.throws(() => validateConfig(root, { ...base, explore: { command: ["x"], properties: ["spec.ts"] } }), /explore\.properties file spec\.ts must be inside specDir, where the agent may write/);
  assert.equal(validateConfig(root, { ...base, explore: { command: ["x", "{url}"], properties: ["t/props.ts"] } }).explore.properties[0], "t/props.ts");
  assert.equal(validateConfig(root, base).explore, null);
});
