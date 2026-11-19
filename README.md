# acceptance-check

Check a pull request's acceptance criteria in a real browser, against the change and against its base, and post the verdicts with a video, trace and screenshot per criterion. An agent can write the tests from the criteria in the description.

A criterion for new behaviour counts as met only when its test **fails on the base and passes on the change**. A test that passes on both is reported as "not proven", so a weak assertion cannot pass.

## How it works

1. Criteria come from the `## Acceptance criteria` list in a pull request description.
2. Each criterion is one Playwright test, tagged `@new` (must fail before the change) or `@holds` (must keep working).
3. `acceptance-check verify` builds this checkout and the base, starts an isolated copy of each with test data, and runs the same tests against both.
4. Each criterion gets a verdict, and `report.md` is ready to post on the pull request.

| Verdict | Meaning |
|---|---|
| Met | A `@new` test fails on the base and passes on the change |
| Still holds | A `@holds` test passes on the change |
| Not met | The test fails on the change |
| Regressed | A `@holds` test passes on the base and fails on the change |
| Not proven | A `@new` test also passes on the base, so it proves nothing |
| No test written | A criterion in the list has no test |
| Not verifiable here | The test is skipped with an `unverifiable` annotation and a reason |

## Install the skills as a plugin

The two skills, `verify-acceptance` and `set-up-acceptance-check`, also ship as a plugin, so an agent can set up and run checks without copying files into each project.

Claude Code:

```
/plugin install acceptance-check --marketplace PatrickPriestley/acceptance-check
```

or, from a shell, `claude plugin marketplace add PatrickPriestley/acceptance-check` then `claude plugin install acceptance-check@acceptance-check`.

Cursor: the manifest is `.cursor-plugin/plugin.json`, with `.cursor-plugin/marketplace.json` at the root, the same layout as Cursor's own plugin repository. Install from `https://github.com/PatrickPriestley/acceptance-check` where your Cursor version adds plugins from a repository. This layout is checked against Cursor's schemas but has not yet been installed in Cursor.

The plugin carries the skills only. Each app still needs the npm package (below), because the checks run with the app's own Playwright. Ask the agent to "set up acceptance-check" and the setup skill walks through the rest.

## Set up an app

```bash
npm install --save-dev github:PatrickPriestley/acceptance-check#v0.5.0 @playwright/test
npx playwright install chromium
npx acceptance-check init
```

`init` writes three starting files:

- `acceptance.config.mjs`: how to install, build and start one isolated copy of the app. See [Config](#config).
- `docs/acceptance-notes.md`: app facts for whoever writes the tests: test data, pages, and what cannot run here.
- `tests/acceptance/fixtures.ts`: a Playwright fixture that resets the app before every test. Only your app knows how to reset itself, so fill this in.

Add `.acceptance/` to `.gitignore`. Runs, base builds and agent logs go there.

`example/` is a complete setup for a tiny app, with a spec.

## Commands

```bash
npx acceptance-check verify --base=origin/main tests/acceptance/feature.spec.ts
npx acceptance-check verify --base=origin/main --criteria=criteria.json --skip-build tests/acceptance/feature.spec.ts
npx acceptance-check criteria pr-body.md > criteria.json
npx acceptance-check specs --base=origin/main [--all-when-none]          # specs this change adds or edits
npx acceptance-check write --body=pr-body.md --spec=tests/acceptance/pr-12.spec.ts --base=origin/main
npx acceptance-check comment .acceptance/runs/<run>/report.md            # print
npx acceptance-check comment --post .acceptance/runs/<run>/report.md     # post or update on the PR
```

| Exit | Meaning |
|---|---|
| 0 | Every criterion is met, still holds or is not verifiable here |
| 2 | A criterion is not met, regressed, not proven, untagged or has no test, or a `@holds` test is weak against its break |
| 1 | The check itself failed: config, build, start-up or Playwright |
| 3 | `write` only: the description has no criteria |

- `--criteria` lists every criterion in the report, including those without a test.
- `--skip-build` reuses a build of this checkout, and refuses if a source file is newer than the build.
- Base builds are cached by commit, so later runs against the same base are fast.

`comment --post` reads `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and `PR_NUMBER`, and optionally `ARTIFACT_URL` and `RUN_URL`. It keeps one comment per pull request and edits it on later runs.

## Config

```js
export default {
  install: ["npm", "ci"],                 // in an exported copy of the base
  build: ["npm", "run", "build"],         // for this checkout and the base
  buildOutputs: ["dist/server.js"],       // for --skip-build
  sources: ["src"],                       // for --skip-build
  start: {
    command: ["node", "dist/server.js"],  // start the built app directly
    health: "/health",                    // answers 200 when ready
    allowEnv: ["PATH", "HOME"],           // the only variables passed through
    env: { PORT: "{port}", DATA_DIR: "{data}" },
  },
  specDir: "tests/acceptance",            // the agent may write only here
  notes: "docs/acceptance-notes.md",      // optional
  playwrightConfig: undefined,            // optional; a built-in one is used otherwise
  outputDir: ".acceptance",               // optional
  report: { setting: "with test data", limits: "" },
  explore: {                              // optional; see Exploration
    command: ["node", "scripts/explore.mjs", "{url}", "{output}"],
    properties: ["tests/acceptance/properties.ts"],
    description: "Bombadil explores the Shop page",
  },
  breaks: [                               // optional; see Break check
    { name: "items-not-saved", description: "The server drops new items.",
      file: "src/items.js", find: "items.push(item);", replace: "" },
  ],
};
```

Commands are arrays and never run through a shell. In `start.env`, `{port}` is a free port and `{data}` a fresh folder for each copy. Nothing else from the environment reaches the app, so database URLs and credentials stay out. The base runs with this checkout's config.

## Break check

A `@new` test proves itself: it has to fail on the base. A `@holds` test passes on both sides, so a weak one, such as a test that only checks the page loaded, would pass forever. The break check closes that gap.

1. The config lists `breaks`: small deliberate faults, each one exact text in one source file and what to replace it with.
2. A `@holds` test names the break it should catch: `annotation: { type: "catches", description: "items-not-saved" }`.
3. After the normal run, `verify` copies this change (uncommitted edits to tracked files included), applies each named break in turn, builds it, and runs the tests that name it.

| Result | Meaning |
|---|---|
| Caught | The test failed with its break, so it can detect that fault |
| Weak: still passes with the break | The test cannot tell the fault apart. Strengthen it, unless the fault cannot be seen from outside at all (another layer already covers it), in which case choose a different break |
| Unknown break | The test names a break the config does not have |
| Break does not build | The fault breaks the build itself, so nothing was checked. Change its find or replace text |

A weak or unknown result exits 2. A `@holds` test that names no break is listed in the report but does not fail the run. The find text must occur exactly once in its file; when the code moves on, `verify` says which break to update. Each break costs one build and one run of its tests, so a few well-chosen breaks go a long way. `--no-breaks` skips the check.

## Exploration

Tests check the paths someone thought of. A property-based explorer, such as [Bombadil](https://github.com/antithesishq/bombadil), checks promises that must hold after any sequence of actions, by acting on the running app at random. `acceptance-check explore` runs the config's explorer against an isolated copy of this change, with `{url}` and `{output}` filled in, and against the base too when it finds something:

| Result | Meaning | Exit |
|---|---|---|
| No violation found | Nothing this time. Exploration is random, so this is evidence, not proof | 0 |
| New violation | Found on this change and not on the base | 2 |
| Violation also on the base | Not caused by this change | 0 |

The explorer command exits 0 when no property was violated and 2 when one was, as Bombadil does. Any other exit means the explorer itself failed, and the run fails with its log: a broken explorer never reads as a pass. It runs in the project root, so it uses this checkout's properties against both copies.

`explore.properties` lists the files the agent may add properties to, and they must be inside `specDir`: the agent may write nowhere else, so the explorer's own entry file imports them. When the config has `explore`, the test-writing agent may add a property for state the change makes visible, run the explorer, and turn a new violation into a test that replays it, titled "Found by exploration: ...". A property it changed is explored again in a separate run, and the result is added to the report.

## Run it on pull requests

Two reusable workflows do the work. In the app's repository, add `.github/workflows/acceptance.yml`:

```yaml
name: Acceptance criteria
on:
  pull_request:
    paths: ["tests/acceptance/**"]
permissions:
  contents: read
  pull-requests: write
jobs:
  acceptance:
    uses: PatrickPriestley/acceptance-check/.github/workflows/acceptance.yml@v0.5.0
```

It checks the specs the pull request adds or changes against the pull request's base, uploads the videos and traces, and keeps one comment on the pull request up to date. When the description has an `## Acceptance criteria` list, every criterion is reported, including those without a test. An `Acceptance base: <commit hash>` line in the description compares against another commit.

A pull request that changes no spec checks nothing by default. Set `when-no-spec-changed: all` to check every spec instead, and add the files that decide how the specs run to the trigger's `paths`: the workflow itself, `package.json` (which pins acceptance-check) and `acceptance.config.mjs`. Then an upgrade or a config change is checked too. Every spec on the base branch should be tagged `@holds` by then; a `@new` test left there passes on both sides and is reported as not proven.

To have the agent write tests when a label is added, add `.github/workflows/acceptance-agent.yml` and an `ANTHROPIC_API_KEY` repository secret:

```yaml
name: Acceptance test writer
on:
  pull_request:
    types: [labeled]
permissions:
  contents: write
  pull-requests: write
jobs:
  write:
    uses: PatrickPriestley/acceptance-check/.github/workflows/acceptance-agent.yml@v0.5.0
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Adding the `write-acceptance-tests` label runs it. It writes `tests/acceptance/pr-<number>.spec.ts`, commits it to the pull request branch, posts the verdicts and removes the label. After the pull request merges, retag its `@new` tests `@holds` and rename the file after the feature it covers. A commit that a workflow pushes does not start other workflows, so its comment is the result for that commit.

| Input | Default | Use |
|---|---|---|
| `working-directory` | `.` | The folder with `acceptance.config.mjs` |
| `install` | `npm ci` | `pnpm install --frozen-lockfile`, `yarn install --immutable`, and so on. pnpm and yarn are enabled through corepack |
| `browsers` | `npx playwright install --with-deps chromium` | |
| `command` | `npx acceptance-check` | `pnpm exec acceptance-check`, for example |
| `spec-dir` | `tests/acceptance` | The config's `specDir`. Agent workflow only; the acceptance workflow reads it from the config |
| `when-no-spec-changed` | `skip` | `all` checks every spec when the pull request changes none. Acceptance workflow only |
| `node-version` | `22` | |
| `label`, `model`, `max-budget-usd` | `write-acceptance-tests`, Claude Code's default, `8` | Agent workflow only |

Both skip pull requests from forks, which get no secrets and a read-only token. While this repository is private, its workflows can be called only from your own repositories, and only after you allow it under Settings, Actions, General, Access.

## Let an agent write the tests

`acceptance-check write` needs Claude Code (`npm i -g @anthropic-ai/claude-code`) and an Anthropic API key.

1. It reads the criteria and builds this change and the base.
2. A Claude Code agent writes one test per criterion, following `skills/verify-acceptance/SKILL.md` and your notes, and checks its work.
3. It undoes any change outside the one spec file, and fails if there was one.
4. It runs the check again itself. The verdicts come from that run, not from the agent, and the agent's notes are added to the report.

The agent runs in Claude Code's default permission mode. It can write only in `specDir`, and its shell is limited to the check, git reads and read-only commands. Do not switch it to `acceptEdits`: that mode lets shell commands such as `sed -i` through. It refuses to start while other files in the project have uncommitted changes.

A pilot run costs about $0.25 to $0.50 and takes 1 to 3 minutes.

## Let an agent propose the criteria

When a pull request changes the app but its description has no criteria, `acceptance-check propose --base=origin/main` has a read-only agent read the diff and the code it touches, and writes `proposal.md`: three to six criteria in the app's own words, and why. It can read files and git history and nothing else. It is not started at all when no file in the config's `sources` changed, and it proposes nothing for a change no user can see. It exits 3 in both cases.

A person stays in charge of what "correct" means. The proposal is a comment, never a change to the description. In CI:

```yaml
name: Acceptance criteria proposal
on:
  pull_request:
    types: [opened, reopened, ready_for_review, labeled]
permissions:
  contents: read
  pull-requests: write
jobs:
  propose:
    uses: PatrickPriestley/acceptance-check/.github/workflows/acceptance-propose.yml@v0.5.0
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

It skips drafts and descriptions that already have criteria. The `propose-acceptance-criteria` label asks again. To have tests written as soon as you paste the criteria into the description, give the test writer `write-on-criteria: true` and the `edited` event:

```yaml
on:
  pull_request:
    types: [labeled, edited]
jobs:
  write:
    uses: PatrickPriestley/acceptance-check/.github/workflows/acceptance-agent.yml@v0.5.0
    with:
      write-on-criteria: true
```

It starts only when an edit adds the list to a description that had none, not on every later edit. A proposal costs well under the default $2 cap.

## Limits

- Web apps tested through Chromium with Playwright. Linux and macOS: base builds use `git archive` and `tar`.
- Only what an isolated copy can reach. Apps that need a database or other services before they start are not supported yet.
- The app may sit in a subfolder of its repository, but this has not been tested.
- The agent needs Claude Code and an Anthropic API key.
- Videos are WebM. GitHub cannot show them inline in a comment, so link the run artifact.

## Develop

```bash
npm install
npm test        # unit tests, and end-to-end tests against example/ in Chromium
```
