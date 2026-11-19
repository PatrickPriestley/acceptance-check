// A tiny property-based explorer for the example app, standing in for a real one
// such as Bombadil. It runs every property in tests/properties.mjs a few times against
// the copy at the URL it is given, and exits 2 on the first violation, as Bombadil does.
// Usage: node explore/run.mjs <url> <output folder>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { properties } from "../tests/properties.mjs";

const [url, output] = process.argv.slice(2);
const trace = [];
for (let round = 1; round <= 3; round++) {
  for (const [name, holds] of Object.entries(properties)) {
    const ok = await holds(url);
    trace.push({ round, name, ok });
    if (!ok) {
      writeFileSync(join(output, "trace.json"), JSON.stringify(trace, null, 2));
      console.log(`Violation: ${name} (round ${round})`);
      process.exit(2);
    }
  }
}
writeFileSync(join(output, "trace.json"), JSON.stringify(trace, null, 2));
console.log(`No violation in ${trace.length} checks`);
