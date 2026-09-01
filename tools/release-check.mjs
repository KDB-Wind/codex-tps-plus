#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginRoot = path.join(root, "plugins", "codex-tps-plus");
const expectedVersion = "0.5.0";

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function text(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const marketplace = json(path.join(".agents", "plugins", "marketplace.json"));
const manifest = json(path.join("plugins", "codex-tps-plus", ".codex-plugin", "plugin.json"));
const rootPackage = json("package.json");
const pluginPackage = json(path.join("plugins", "codex-tps-plus", "package.json"));
const hooks = json(path.join("plugins", "codex-tps-plus", "hooks", "hooks.json"));
const changelog = text("CHANGELOG.md");
const releaseChecklist = text("RELEASE-CHECKLIST.md");

assert.equal(marketplace.name, "kdb-wind");
assert.equal(marketplace.plugins.length, 1);
assert.deepEqual(marketplace.plugins[0], {
  name: "codex-tps-plus",
  source: { source: "local", path: "./plugins/codex-tps-plus" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});

assert.equal(path.basename(pluginRoot), manifest.name);
assert.equal(manifest.version, expectedVersion);
assert.equal(pluginPackage.version, expectedVersion);
assert.equal(rootPackage.version, expectedVersion);
assert.equal(manifest.license, "MIT");
assert.equal(manifest.repository, "https://github.com/KDB-Wind/codex-tps-plus");
assert.ok(Array.isArray(manifest.interface.defaultPrompt));
assert.ok(manifest.interface.defaultPrompt.length <= 3);
assert.doesNotMatch(manifest.version, /\+codex\./);
assert.match(
  changelog,
  new RegExp(`^## ${expectedVersion.replace(/\./g, "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m")
);
assert.match(
  releaseChecklist,
  new RegExp("tagged `v" + expectedVersion.replace(/\./g, "\\.") + "`")
);

const stopGroups = hooks?.hooks?.Stop;
assert.deepEqual(Object.keys(hooks?.hooks || {}), ["Stop"]);
assert.equal(stopGroups.length, 1);
assert.equal(stopGroups[0].hooks.length, 2);
assert.match(stopGroups[0].hooks[0].command, /collector\.mjs/);
assert.match(stopGroups[0].hooks[0].command, /PLUGIN_DATA.*runtime\/dispatch\.mjs/);
assert.match(stopGroups[0].hooks[0].commandWindows, /PLUGIN_DATA.*runtime\\dispatch\.mjs/);
assert.notEqual(stopGroups[0].hooks[0].async, true);
assert.match(stopGroups[0].hooks[1].command, /backfill\.mjs/);
assert.match(stopGroups[0].hooks[1].command, /PLUGIN_DATA.*runtime\/dispatch\.mjs/);
assert.match(stopGroups[0].hooks[1].commandWindows, /PLUGIN_DATA.*runtime\\dispatch\.mjs/);
assert.equal(stopGroups[0].hooks[1].async, true);

for (const required of [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  path.join("plugins", "codex-tps-plus", "LICENSE"),
  path.join("plugins", "codex-tps-plus", "hooks", "collector.mjs"),
  path.join("plugins", "codex-tps-plus", "hooks", "backfill.mjs"),
  path.join("plugins", "codex-tps-plus", "scripts", "runtime-dispatch.mjs"),
  path.join("plugins", "codex-tps-plus", "scripts", "runtime-snapshot.mjs"),
]) {
  assert.ok(fs.existsSync(path.join(root, required)), `missing required release file: ${required}`);
}

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean);
const forbiddenNames = tracked.filter(
  (file) =>
    /(^|\/)REVIEW\.md$/i.test(file) ||
    /(^|\/)artifacts\//i.test(file) ||
    /\.(?:bin|raw)$/i.test(file)
);
assert.deepEqual(forbiddenNames, [], `forbidden release files are tracked: ${forbiddenNames.join(", ")}`);

const textExtensions = new Set([".json", ".jsonl", ".md", ".mjs", ".toml", ".yaml", ".yml"]);
const localPathLeaks = [];
for (const file of tracked) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) continue;
  const content = fs.readFileSync(absolute, "utf8");
  if (/[A-Za-z]:\\(?:Users|Project)\\/i.test(content)) localPathLeaks.push(file);
}
assert.deepEqual(localPathLeaks, [], `local absolute paths remain in: ${localPathLeaks.join(", ")}`);

process.stdout.write(
  `${JSON.stringify({ ok: true, version: expectedVersion, trackedFiles: tracked.length })}\n`
);
