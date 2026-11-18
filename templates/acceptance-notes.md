# Acceptance test notes

Facts about this app for anyone writing acceptance tests, including the agent behind `acceptance-check write`.

## The app under test

- How each copy starts and what data it has.
- Import `test` and `expect` from `tests/acceptance/fixtures.ts`. Describe what state the fixture resets the app to before each test.
- The main pages and their paths.
- A worked example spec, once there is one.

## Not verifiable here

List what a test copy cannot reach, so those criteria are marked not verifiable instead of failing. For example: sign-in, payments, email, third-party services.

## Never

- Point a test copy at real data, a hosted account or real credentials.
