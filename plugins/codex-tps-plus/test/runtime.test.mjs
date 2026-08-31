import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureStableRuntime } from "../scripts/runtime-snapshot.mjs";
import { readSessionStatus } from "../scripts/status-core.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));

function runShell(command, options = {}) {
  const executable = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "/bin/sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  return spawnSync(executable, args, {
    encoding: "utf8",
    ...options,
  });
}

function envWithTestNode(overrides = {}) {
  return {
    ...process.env,
    ...overrides,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
  };
}

test("Hook commands degrade to strict JSON when a session's version cache was removed", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-missing-cache-"));
  const emptyData = path.join(temp, "data");
  fs.mkdirSync(emptyData);
  for (const hook of hooks.hooks.Stop[0].hooks) {
    const command = process.platform === "win32" ? hook.commandWindows : hook.command;
    const result = runShell(command, {
      input: "{}",
      env: envWithTestNode({
        PLUGIN_ROOT: path.join(temp, "removed-version"),
        PLUGIN_DATA: emptyData,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("Hook commands degrade to strict JSON when Node is unavailable", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-missing-node-"));
  for (const hook of hooks.hooks.Stop[0].hooks) {
    const command = process.platform === "win32" ? hook.commandWindows : hook.command;
    const result = runShell(command, {
      input: "{}",
      env: {
        ...process.env,
        PATH: "",
        PLUGIN_ROOT: root,
        PLUGIN_DATA: path.join(temp, "data"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("a normal collector invocation seeds the version-independent runtime", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-runtime-seed-"));
  const pluginData = path.join(temp, "plugin-data");
  const collector = hooks.hooks.Stop[0].hooks[0];
  const command = process.platform === "win32" ? collector.commandWindows : collector.command;
  const result = runShell(command, {
    input: "{}",
    env: envWithTestNode({ PLUGIN_ROOT: root, PLUGIN_DATA: pluginData }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(fs.existsSync(path.join(pluginData, "runtime", "dispatch.mjs")), true);
  assert.equal(fs.existsSync(path.join(pluginData, "runtime", "active.json")), true);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("stable runtime dispatches a Stop hook after the installed version root disappears", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-stable-runtime-"));
  const pluginData = path.join(temp, "plugin-data");
  const statusData = path.join(temp, "status-data");
  const transcript = path.join(temp, "rollout.jsonl");
  const now = Date.now();
  fs.writeFileSync(
    transcript,
    [
      {
        timestamp: new Date(now - 3000).toISOString(),
        type: "event_msg",
        payload: { type: "task_started", turn_id: "stable-turn", started_at: (now - 3000) / 1000 },
      },
      {
        timestamp: new Date(now - 1000).toISOString(),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [] },
      },
      {
        timestamp: new Date(now - 900).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { output_tokens: 20, reasoning_output_tokens: 5 },
            total_token_usage: { output_tokens: 20 },
          },
        },
      },
    ].map(JSON.stringify).join("\n")
  );
  const snapshot = ensureStableRuntime({ pluginRoot: root, pluginData });
  assert.equal(snapshot.available, true);
  assert.equal(fs.existsSync(snapshot.dispatchPath), true);

  const result = spawnSync(
    process.execPath,
    [snapshot.dispatchPath, "collector", "Stop"],
    {
      input: JSON.stringify({
        session_id: "stable-session",
        turn_id: "stable-turn",
        transcript_path: transcript,
      }),
      env: {
        ...process.env,
        PLUGIN_ROOT: path.join(temp, "removed-version"),
        PLUGIN_DATA: pluginData,
        TPS_PLUS_DATA_DIR: statusData,
      },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).systemMessage, /整轮.*tok\/s/);

  fs.appendFileSync(
    transcript,
    `\n${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "stable-turn",
        time_to_first_token_ms: 500,
        duration_ms: 3000,
      },
    })}\n`
  );
  const backfill = spawnSync(
    process.execPath,
    [snapshot.dispatchPath, "backfill", "Stop"],
    {
      input: JSON.stringify({
        session_id: "stable-session",
        turn_id: "stable-turn",
        transcript_path: transcript,
      }),
      env: {
        ...process.env,
        PLUGIN_ROOT: path.join(temp, "removed-version"),
        PLUGIN_DATA: pluginData,
        TPS_PLUS_DATA_DIR: statusData,
      },
      encoding: "utf8",
    }
  );
  assert.equal(backfill.status, 0, backfill.stderr);
  assert.deepEqual(JSON.parse(backfill.stdout), {});
  assert.equal(
    readSessionStatus({ dataDir: statusData, sessionId: "stable-session" }).latest.ttftMs,
    500
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("stable runtime retains at most five content-addressed snapshots", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-runtime-retention-"));
  const pluginRoot = path.join(temp, "plugin");
  const pluginData = path.join(temp, "plugin-data");
  fs.cpSync(root, pluginRoot, { recursive: true });
  let active = null;
  for (let index = 0; index < 6; index += 1) {
    fs.appendFileSync(path.join(pluginRoot, "scripts", "status-core.mjs"), `\n// snapshot ${index}\n`);
    active = ensureStableRuntime({ pluginRoot, pluginData }).fingerprint;
  }
  const snapshotsRoot = path.join(pluginData, "runtime", "snapshots");
  const snapshots = fs
    .readdirSync(snapshotsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map((entry) => entry.name);
  assert.equal(snapshots.length, 5);
  assert.equal(snapshots.includes(active), true);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("an older surviving plugin root cannot roll the stable runtime back", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-runtime-version-"));
  const pluginRoot = path.join(temp, "plugin");
  const pluginData = path.join(temp, "plugin-data");
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  fs.cpSync(root, pluginRoot, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: "0.4.1" })}\n`);
  fs.appendFileSync(path.join(pluginRoot, "scripts", "status-core.mjs"), "\n// newer runtime\n");
  const newer = ensureStableRuntime({ pluginRoot, pluginData });
  assert.equal(newer.activated, true);

  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: "0.4.0" })}\n`);
  fs.appendFileSync(path.join(pluginRoot, "scripts", "status-core.mjs"), "\n// older runtime\n");
  const older = ensureStableRuntime({ pluginRoot, pluginData });
  assert.equal(older.activated, false);
  const active = JSON.parse(
    fs.readFileSync(path.join(pluginData, "runtime", "active.json"), "utf8")
  );
  assert.equal(active.version, "0.4.1");
  assert.equal(active.snapshot, newer.fingerprint);
  fs.rmSync(temp, { recursive: true, force: true });
});
