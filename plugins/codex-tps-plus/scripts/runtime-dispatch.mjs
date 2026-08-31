#!/usr/bin/env node

// Version-independent fallback for sessions whose installed PLUGIN_ROOT was
// removed by a later plugin update. This file lives under PLUGIN_DATA/runtime.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function emptyOutput() {
  process.stdout.write("{}");
}

try {
  const kind = process.argv[2];
  const eventName = process.argv[3] || "Stop";
  if (!new Set(["collector", "backfill"]).has(kind)) throw new Error("unsupported hook");

  const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
  const pointer = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "active.json"), "utf8"));
  if (!/^[0-9a-f]{64}$/.test(pointer?.snapshot || "")) throw new Error("invalid snapshot");

  const snapshotRoot = path.resolve(runtimeRoot, "snapshots", pointer.snapshot);
  const target = path.resolve(snapshotRoot, "hooks", `${kind}.mjs`);
  if (!target.startsWith(`${snapshotRoot}${path.sep}`) || !fs.statSync(target).isFile()) {
    throw new Error("missing hook snapshot");
  }

  const result = spawnSync(process.execPath, [target, eventName], {
    input: fs.readFileSync(0),
    encoding: "utf8",
    env: { ...process.env, TPS_PLUS_STABLE_DISPATCH: "1" },
    windowsHide: true,
    timeout: 14_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw result.error || new Error("hook failed");
  const output = JSON.parse(result.stdout.trim() || "{}");
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("invalid hook output");
  }
  process.stdout.write(JSON.stringify(output));
} catch {
  emptyOutput();
}
