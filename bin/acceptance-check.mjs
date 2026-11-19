#!/usr/bin/env node
// acceptance-check: check a pull request's acceptance criteria in a real browser,
// against the change and its base, and let an agent write the tests.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { commentBody, postComment } from "../src/comment.mjs";
import { CONFIG_FILE } from "../src/config.mjs";
import { parseCriteria } from "../src/criteria.mjs";
import { propose } from "../src/propose.mjs";
import { listSpecs } from "../src/specs.mjs";
import { verify } from "../src/verify.mjs";
import { write } from "../src/write.mjs";

const USAGE = `Usage: acceptance-check <command> [options]

Commands:
  verify [--base=<ref>] [--skip-build] [--criteria=<file.json>] [--no-breaks] <spec>...
      Run the specs against this checkout and the base, then run each @holds test
      that names a break against a copy of this change with that break applied.
      Exit 0 when every criterion is met or still holds and every break is caught,
      2 when not, 1 when the check itself failed. --no-breaks skips the break check.
  write --body=<pr-body.md> --spec=<spec folder>/<name>.spec.ts [--base=<ref>]
        [--model=<model>] [--max-budget-usd=8] [--max-runs=4]
      Have an agent write one test per criterion in the description, then check them.
      Exit 3 when the description has no "## Acceptance criteria" list.
  explore [--base=<ref>] [--skip-build]
      Run the config's explorer against this checkout, and against the base when it
      finds a violation. Exit 0 when nothing new is found, 2 for a new violation.
  propose [--base=<ref>] [--model=<model>] [--max-budget-usd=2]
      Have a read-only agent propose acceptance criteria for a change that has none.
      Writes a comment-ready proposal.md. Exit 3 when no app source changed or the
      agent finds no visible change.
  specs --base=<ref> [--all-when-none]
      Print the specs that this checkout adds or changes since the base, one per line.
      With --all-when-none, print every spec in specDir when none changed.
  criteria <pr-body.md>
      Print the criteria in a pull request description as JSON.
  comment [--post] [<report.md>]
      Print the pull request comment for a report. With --post, post or update it,
      using GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER. ARTIFACT_URL and RUN_URL are optional.
  init
      Write a starting ${CONFIG_FILE}, notes file and fixtures in this folder.

--base defaults to origin/main.`;

const [command, ...rest] = process.argv.slice(2);
const parse = (options) => parseArgs({ args: rest, allowPositionals: true, options });

async function main() {
  switch (command) {
    case "verify": {
      const { values, positionals } = parse({
        base: { type: "string" },
        "skip-build": { type: "boolean" },
        criteria: { type: "string" },
        "prepare-only": { type: "boolean" },
        "no-breaks": { type: "boolean" },
      });
      const result = await verify({ base: values.base, skipBuild: values["skip-build"], criteria: values.criteria, prepareOnly: values["prepare-only"], breaks: !values["no-breaks"], specs: positionals });
      return result.code;
    }
    case "write": {
      const { values } = parse({
        body: { type: "string" },
        spec: { type: "string" },
        base: { type: "string" },
        model: { type: "string" },
        "max-budget-usd": { type: "string" },
        "max-runs": { type: "string" },
      });
      if (!values.body || !values.spec) return usage();
      const result = await write({ body: values.body, spec: values.spec, base: values.base, model: values.model, maxBudgetUsd: values["max-budget-usd"], maxRuns: values["max-runs"] });
      return result.code;
    }
    case "explore": {
      const { values } = parse({ base: { type: "string" }, "skip-build": { type: "boolean" } });
      return (await verify({ base: values.base, skipBuild: values["skip-build"], explore: true, specs: [] })).code;
    }
    case "propose": {
      const { values } = parse({ base: { type: "string" }, model: { type: "string" }, "max-budget-usd": { type: "string" } });
      return (await propose({ base: values.base, model: values.model, maxBudgetUsd: values["max-budget-usd"] })).code;
    }
    case "specs": {
      const { values } = parse({ base: { type: "string" }, "all-when-none": { type: "boolean" } });
      const { specs, changed } = await listSpecs({ base: values.base, allWhenNone: values["all-when-none"] });
      if (!changed) console.error(`[acceptance-check] No spec changed since ${values.base}; checking all ${specs.length}.`);
      for (const spec of specs) console.log(spec);
      return 0;
    }
    case "criteria": {
      if (!rest[0]) return usage();
      console.log(JSON.stringify(parseCriteria(readFileSync(rest[0], "utf8")), null, 2));
      return 0;
    }
    case "comment": {
      const { values, positionals } = parse({ post: { type: "boolean" } });
      const body = commentBody(positionals[0], process.env);
      if (!values.post) {
        process.stdout.write(body);
        return 0;
      }
      console.log(`Comment at ${await postComment(body, process.env)}`);
      return 0;
    }
    case "init":
      return init();
    default:
      return usage(command && !["-h", "--help", "help"].includes(command));
  }
}

function usage(unknown = true) {
  (unknown ? console.error : console.log)(USAGE);
  return unknown ? 1 : 0;
}

function init() {
  const templates = fileURLToPath(new URL("../templates/", import.meta.url));
  const files = [
    [CONFIG_FILE, CONFIG_FILE],
    ["acceptance-notes.md", "docs/acceptance-notes.md"],
    ["fixtures.ts", "tests/acceptance/fixtures.ts"],
  ];
  for (const [from, to] of files) {
    if (existsSync(to)) {
      console.log(`Kept ${to}, which already exists`);
      continue;
    }
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(join(templates, from), to);
    console.log(`Wrote ${to}`);
  }
  console.log(`\nNext: fill in ${CONFIG_FILE}, describe the app in docs/acceptance-notes.md, make the fixture reset your app's data, and add .acceptance/ to .gitignore.`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[acceptance-check] ${error.message}`);
  process.exitCode = 1;
}
