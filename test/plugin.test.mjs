import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("package and plugin manifests carry the same name and version", () => {
  const pkg = json("package.json");
  for (const path of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const manifest = json(path);
    assert.equal(manifest.name, pkg.name, path);
    assert.equal(manifest.version, pkg.version, path);
  }
  for (const path of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    const entry = json(path).plugins.find((p) => p.name === pkg.name);
    assert.ok(entry, `${path} lists ${pkg.name}`);
    assert.ok(existsSync(join(root, entry.source, path.split("/")[0], "plugin.json")), `${path} source has a manifest`);
  }
});

test("every skill has front matter whose name matches its folder", () => {
  const skills = readdirSync(join(root, "skills"));
  assert.ok(skills.length > 0);
  for (const name of skills) {
    const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, `${name} has front matter`);
    assert.match(front[1], new RegExp(`^name: ${name}$`, "m"));
    assert.match(front[1], /^description: .{40,}$/m);
  }
});

test("docs and skills pin the current version", () => {
  const { version } = json("package.json");
  const files = ["README.md", ...readdirSync(join(root, "skills")).map((n) => `skills/${n}/SKILL.md`)];
  for (const path of files) {
    for (const [, pinned] of readFileSync(join(root, path), "utf8").matchAll(/acceptance-check[^\s#@]*[#@]v(\d+\.\d+\.\d+)/g)) {
      assert.equal(pinned, version, `${path} pins v${pinned}`);
    }
  }
});
