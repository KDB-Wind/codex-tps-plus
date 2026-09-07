import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("candidate and tagged-release checks enforce distinct release boundaries", (t) => {
  const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tps-release-check-"));
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("tps-release-check-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const relative of files) {
    const target = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  const git = (...args) => execFileSync("git", args, { cwd: temporary, stdio: "pipe" });
  git("init");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const version = JSON.parse(fs.readFileSync(path.join(temporary, "package.json"))).version;
  const env = { ...process.env };
  delete env.GITHUB_REF_TYPE;
  delete env.GITHUB_REF_NAME;
  const check = (mode, extra = {}) => spawnSync(process.execPath, ["tools/release-check.mjs", mode],
    { cwd: temporary, env: { ...env, ...extra }, encoding: "utf8", windowsHide: true });
  assert.equal(check("--candidate").status, 0);
  assert.notEqual(check("--release").status, 0, "release requires its exact tag");
  git("tag", `v${version}`);
  assert.equal(check("--candidate").status, 0, "fetching a release tag must not break branch CI");
  assert.equal(check("--release").status, 0);
  assert.notEqual(check("--release", { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" }).status, 0);
  fs.appendFileSync(path.join(temporary, "README.md"), "\nrelease test\n");
  assert.notEqual(check("--release").status, 0, "release must reject uncommitted changes");
  git("add", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-m", "after tag");
  assert.notEqual(check("--release").status, 0, "release tag must point to HEAD");
  assert.notEqual(check("--unknown").status, 0);
});
