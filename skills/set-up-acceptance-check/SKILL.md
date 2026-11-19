---
name: set-up-acceptance-check
description: Set up acceptance-check in a web app repository, so pull request acceptance criteria can be checked in a real browser against the change and its base. Use when asked to "set up acceptance-check", "add acceptance checks", or when the verify-acceptance skill finds no acceptance.config.mjs in the project.
---

# Set up acceptance-check

The goal is one isolated copy of the app that starts from a build, with test data, on a port it is given, and resets between tests. Everything else is wiring. Work through the steps in order and run the check at the end; a setup counts as done only when an example spec gets the verdicts it should.

## 1. Install

```bash
npm install --save-dev github:PatrickPriestley/acceptance-check#v0.4.1 @playwright/test
npx playwright install chromium
npx acceptance-check init
```

Use the project's package manager (`pnpm add -D`, adding `-w` at a pnpm workspace root; `yarn add -D`). `init` writes `acceptance.config.mjs`, `docs/acceptance-notes.md` and `tests/acceptance/fixtures.ts` and never overwrites a file. Add `.acceptance/` to `.gitignore`.

## 2. Fill in `acceptance.config.mjs`

Read the project's build scripts, server entry point and any `.env` loading before you write anything.

- `install` and `build` are arrays: the program, then its arguments. Nothing runs through a shell.
- `start.command` starts the built app directly, not through a script that loads `.env`. A script that loads `.env` would hand the copy real settings.
- `start.env` points every data location at `{data}`, a fresh folder per copy, and the port at `{port}`. If the app can read a database URL, an API key or an account from the environment, make sure the copy cannot reach a real one: leave those variables out of `allowEnv` and set any the app needs to local or fake values.
- `start.health` is a path that answers 200 once the app is ready. Add one if the app has none.
- `buildOutputs` and `sources` let `--skip-build` refuse a stale build.

Never point the copy at production data, a hosted account or real credentials. If the app cannot run without a service it does not start itself, stop and tell the user what is missing.

## 3. Fill in the fixture

`tests/acceptance/fixtures.ts` resets the app before every test. Only the app knows how: an API route that restores seed data, a fresh data file, or a database reset that the copy owns. If none exists, propose the smallest one, available only in the test setting, and ask before adding it to the app.

## 4. Write the notes

`docs/acceptance-notes.md` is what a test writer reads first, person or agent. Give the test data the reset produces, the main pages and how to reach them, which requests to watch, one worked example spec, and what cannot run here (sign-in, payments, email, third-party sites).

## 5. Prove it

Write one small spec for behaviour that already works, tagged `@holds`, and run:

```bash
npx acceptance-check verify --base=origin/main tests/acceptance/<name>.spec.ts
```

It should exit 0 with "Still holds". Then change the assertion so it is false and run again: it should exit 2 with "Not met". Put the assertion back. Report both runs to the user, with the report path under `.acceptance/runs/`.

## 6. CI, if the user wants it

The repository ships reusable workflows. A caller looks like this:

```yaml
jobs:
  acceptance:
    uses: PatrickPriestley/acceptance-check/.github/workflows/acceptance.yml@v0.4.1
    with:
      install: npm ci
      browsers: npx playwright install --with-deps chromium
      command: npx acceptance-check
```

With `when-no-spec-changed: all`, and the workflow, `package.json` and `acceptance.config.mjs` added to the trigger's `paths`, a pull request that upgrades acceptance-check or changes its config checks every spec. Suggest it once the existing specs are tagged `@holds`.

`acceptance-agent.yml` writes the tests from the criteria when a label is added and needs an `anthropic-api-key` secret. Adding a secret is the user's job; say which one.
