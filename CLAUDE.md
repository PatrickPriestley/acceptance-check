# acceptance-check

A Node package, no runtime dependencies, Node 20 or later. `bin/acceptance-check.mjs` is the command line; the engine is in `src/`.

- `npm test` runs the unit tests and the end-to-end tests. The end-to-end tests build a two-commit copy of `example/` in `test/.tmp/` and run the real command in Chromium. Run them before calling a change done.
- Nothing in `src/`, `skill/` or `templates/` may name a particular app. App facts belong in that app's `acceptance.config.mjs` and notes file.
- `src/verdicts.mjs` defines what counts as met. Change it only with a matching change to the unit tests and the README's verdict table.
- The agent's permissions in `src/write.mjs` are a safety boundary. Never use the `acceptEdits` permission mode, and keep writes scoped to `specDir`.
- Never merge a pull request without explicit human approval.
