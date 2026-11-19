---
name: verify-acceptance
description: Check a pull request's acceptance criteria in a real browser, against the change and against its base, with a video, trace and screenshot per criterion. Use when a PR or task states acceptance criteria for behaviour a user can see, when asked to "validate the acceptance criteria", or when preparing evidence for a PR comment.
---

# Verify acceptance criteria

`acceptance-check verify` runs each criterion as a Playwright test against two isolated copies of the app: this checkout and a base revision. A new behaviour counts as met only when its test fails on the base and passes on the change. That is what stops a weak assertion from passing.

This skill is the method. Two files hold everything about this particular app:

- `acceptance.config.mjs` says how to install, build and start an isolated copy, which environment variables it may see, and where specs live.
- The notes file it names gives the facts a test writer needs: test data, fixtures, pages, a worked example and what cannot run in this setting. Read it before writing tests.

## 1. Find the criteria

Take them from the `## Acceptance criteria` section of the PR description, or the linked issue, or the task you were given. Do not invent criteria. If there are none, or one is too vague to observe in the browser, say so and stop for that criterion.

## 2. Write one test per criterion

Put them in `<spec folder>/<feature>.spec.ts`, using the spec folder from the config. Copy the shape of the worked example the notes name, and use the fixtures they describe.
- Use the criterion's words, close to verbatim, as the test title.
- Tag each test:
  - `@new` for behaviour this change introduces. It must fail on the base.
  - `@holds` for behaviour that must still work. It may pass on both.
  - `@new` means new in the pull request that adds the test. Once that pull request merges, the behaviour is in every later base, so retag its tests `@holds` when you next change the spec. Otherwise they report "Not proven" against any later base. At the same time, rename an agent's `pr-<number>.spec.ts` after the feature it covers, so the file still means something later.
- Name the break each `@holds` test should catch, from the config's `breaks`: `annotation: { type: "catches", description: "<break name>" }` (an array of annotations when there is more than one). The check applies that fault to a copy of the change and the test must fail there. If no break fits, name none and suggest one for the config.
- Assert what the criterion promises and the user or the server can observe: visible text, focus, stored data, whether a request was sent. Not CSS classes or component internals.
- Drive the app by roles, labels and accessible names. Use `page.goto` with paths relative to the app. The base URL is set for you.
- If a criterion cannot be checked in this setting (the notes list what cannot run), keep its test, add `annotation: { type: "unverifiable", description: "<reason>" }` to its details and call `test.skip()` in its body. It is reported as not verifiable, with the reason. Never use this because a test is hard to write.

## 3. Run it

```bash
npx acceptance-check verify --base=<base ref> <spec folder>/<feature>.spec.ts
```

`--base` defaults to `origin/main`. For a pull request, use its base branch. For criteria written after the change merged, use the commit before the change. `--skip-build` reuses a current build of this checkout. The base build is cached in `<outputDir>/bases/` (`.acceptance/` by default), so later runs against the same base are fast.

Add `--criteria=<file.json>`, a JSON list of the criteria, to have every criterion reported, including any without a test. `acceptance-check criteria <pr-body.md>` extracts that list from a pull request description.

| Exit | Meaning |
|---|---|
| 0 | Every criterion is met or still holds |
| 2 | A criterion is not met, regressed, not proven or untagged |
| 1 | The harness failed: build, start-up or Playwright error |

When the config has `explore`, also run `acceptance-check explore --base=<base>` for a change to state a user can see. A new violation is a finding: replay the trace as a test before fixing anything.

## 4. Read the verdicts

| Verdict | What to do |
|---|---|
| Met, Still holds | Report it |
| Not met | The change does not do what the criterion says. Fix the change, or report it |
| Regressed | Something that worked on the base is now broken. Fix the change |
| Not proven: also passes on base | The test does not distinguish the change. Strengthen the assertion. Never retag it `@holds` just to pass |
| Not proven: base could not run | Read `base-build.log` in the run folder |
| No test written | Write a test for the criterion, or mark it not verifiable with the reason |
| Not verifiable here | Say so in your report. Someone has to check it another way |
| Break check: Weak | The `@holds` test still passes with the fault it names. Strengthen the assertion. If the fault cannot be seen from outside at all (another layer covers it), name a different break and say why. Never drop a break just to pass |
| Break check: Unknown break | Fix the name, or add the break to the config |

Never weaken an assertion to get a pass.

## 5. Report

The run folder `<outputDir>/runs/<run>/` holds `report.md`, ready to post as a PR comment, plus a `video.webm`, `trace.zip` and screenshot per criterion under `head/results/` and `base/results/`. Watch the videos of failures before you explain them.

`acceptance-check comment <report.md>` prints the comment, and `--post` posts it or updates the one already on the pull request. In CI, run the specs a pull request adds or changes, upload the run folder as an artifact, and post the comment with the artifact link in `ARTIFACT_URL`. To compare against a commit other than the pull request base, a workflow can read a line `Acceptance base: <commit hash>` from the description.

## Let an agent write the tests

`acceptance-check write --body=<pr-body.md> --spec=<spec folder>/<name>.spec.ts --base=<ref>` does steps 1 to 4 with a Claude Code agent:

1. It reads the criteria from the `## Acceptance criteria` section of the description.
2. It builds this change and the base, then has the agent write one test per criterion in the spec, following this skill and the app notes. The agent can write files only in the spec folder, and its shell commands are limited to the acceptance check, git reads and other read-only commands. Its instructions are in `src/agent-prompt.md` in this package.
3. It undoes any change outside the spec and fails if there was one.
4. It runs the check again itself. The verdicts come from that run, not from the agent, and the agent's notes are added to the report.

It needs Claude Code installed and an API key (`ANTHROPIC_API_KEY` in CI), and it refuses to start if other files in the project have uncommitted changes. A commit that a GitHub workflow pushes does not start other workflows, so a workflow that commits the spec should also post the comment itself.

## Limits

- Only what the configured setting can run. The app notes list what is out of reach; report those criteria as not verifiable here.
- Videos are WebM. GitHub cannot show them inline in a comment, so the comment links to the artifact.
- Test data only. Never point a copy at real data, a hosted account or real credentials. The config's environment allowlist is what keeps them out.
- The base runs with this checkout's config, so a base from before the config existed still works if the same commands build and start it.
