// How each criterion is judged from its test's result on the change and on the base.

/**
 * @typedef {{ passed: boolean, skipped?: boolean, unverifiable?: string | null }} SideResult
 * @typedef {{ label: string, ok: boolean, warn?: boolean }} Verdict
 */

// A new criterion is met only when its test fails before the change and passes
// after it. A test that already passes on the base proves nothing.
export const VERDICTS = {
  met: { label: "Met", ok: true },
  holds: { label: "Still holds", ok: true },
  notMet: { label: "Not met", ok: false },
  regressed: { label: "Regressed", ok: false },
  notProven: { label: "Not proven: also passes on base", ok: false },
  noBase: { label: "Not proven: base could not run", ok: false },
  untagged: { label: "Invalid: tag the test @new or @holds", ok: false },
  skipped: { label: "Skipped without a reason", ok: false },
  noTest: { label: "No test written", ok: false },
};

/**
 * @param {"new" | "holds" | null} kind
 * @param {SideResult | null | undefined} head
 * @param {SideResult | null | undefined} base
 * @returns {Verdict}
 */
export function verdict(kind, head, base) {
  if (!head) return VERDICTS.noTest;
  if (head.skipped && head.unverifiable) return { label: `Not verifiable here: ${head.unverifiable}`, ok: true, warn: true };
  if (head.skipped) return VERDICTS.skipped;
  if (!kind) return VERDICTS.untagged;
  if (kind === "new") {
    if (!head.passed) return VERDICTS.notMet;
    if (!base) return VERDICTS.noBase;
    return base.passed ? VERDICTS.notProven : VERDICTS.met;
  }
  if (head.passed) return VERDICTS.holds;
  return base?.passed ? VERDICTS.regressed : VERDICTS.notMet;
}
