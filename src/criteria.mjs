// Extract acceptance criteria from a pull request description.

/**
 * Items under the first "Acceptance criteria" heading, up to the next heading.
 * Checkbox, bullet and numbered items are accepted. Indented lines continue the item above.
 */
export function parseCriteria(markdown) {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s*acceptance criteria\s*:?\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const criteria = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const item = line.match(/^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/);
    if (item) criteria.push(item[1]);
    else if (/^\s{2,}\S/.test(line) && criteria.length) criteria[criteria.length - 1] += ` ${line.trim()}`;
  }
  return criteria.map(normalizeCriterion).filter(Boolean);
}

/** The form used to match a criterion to a test title. */
export function normalizeCriterion(text) {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}
