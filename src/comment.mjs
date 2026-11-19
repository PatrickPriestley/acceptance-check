// Prints, posts or updates the single acceptance-criteria comment on a pull request.
import { existsSync, readFileSync } from "node:fs";

export const MARKER = "<!-- acceptance-agent -->";
const MARKERS = [MARKER, "<!-- acceptance-proposal -->"];

/** The comment body, with the artifact link filled in. */
export function commentBody(report, { ARTIFACT_URL, RUN_URL = "" } = {}) {
  let body = report && existsSync(report)
    ? readFileSync(report, "utf8")
    : `${MARKER}\n## Acceptance criteria\n\nThe check did not produce a report. See the [workflow run](${RUN_URL}).\n`;
  body = body.replaceAll("{{ARTIFACT_URL}}", ARTIFACT_URL || RUN_URL);
  if (RUN_URL) body += `\n<sub>Posted by acceptance-check. [Run log](${RUN_URL})</sub>\n`;
  return body;
}

/** Posts the body, or edits the comment that already carries the marker. Returns its URL. */
export async function postComment(body, { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, GITHUB_API_URL = "https://api.github.com" }) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/.test(PR_NUMBER ?? "")) {
    throw new Error("Posting needs GITHUB_TOKEN, GITHUB_REPOSITORY and a numeric PR_NUMBER.");
  }
  const github = async (path, init = {}) => {
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  };
  // Verdicts and proposals each keep one comment, told apart by the marker they start with.
  const marker = MARKERS.find((item) => body.startsWith(item)) ?? MARKER;
  let existing;
  for (let page = 1; !existing; page++) {
    const comments = await github(`/issues/${PR_NUMBER}/comments?per_page=100&page=${page}`);
    existing = comments.find((comment) => comment.body?.startsWith(marker));
    if (comments.length < 100) break;
  }
  const payload = { method: existing ? "PATCH" : "POST", body: JSON.stringify({ body }) };
  const comment = existing
    ? await github(`/issues/comments/${existing.id}`, payload)
    : await github(`/issues/${PR_NUMBER}/comments`, payload);
  return comment.html_url;
}
