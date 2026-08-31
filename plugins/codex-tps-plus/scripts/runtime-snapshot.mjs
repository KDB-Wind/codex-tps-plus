import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SNAPSHOT_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RUNTIME_SNAPSHOTS = 5;
const RUNTIME_FILES = [
  "hooks/backfill.mjs",
  "hooks/collector.mjs",
  "scripts/direct-run.mjs",
  "scripts/probe-core.mjs",
  "scripts/runtime-dispatch.mjs",
  "scripts/runtime-snapshot.mjs",
  "scripts/status-core.mjs",
];

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    try {
      fs.renameSync(temporary, file);
      return true;
    } catch (error) {
      if (!fs.existsSync(file)) throw error;
      return false;
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function runtimeFingerprint(pluginRoot) {
  const hash = crypto.createHash("sha256");
  for (const relative of RUNTIME_FILES) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(pluginRoot, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function manifestVersion(pluginRoot) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  if (typeof manifest?.version !== "string") throw new Error("missing plugin version");
  return manifest.version;
}

function versionCore(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  return match ? match.slice(1).map(Number) : null;
}

function isSameOrNewerVersion(candidate, active) {
  const candidateCore = versionCore(candidate);
  const activeCore = versionCore(active);
  if (!candidateCore || !activeCore) return active === null;
  for (let index = 0; index < candidateCore.length; index += 1) {
    if (candidateCore[index] !== activeCore[index]) {
      return candidateCore[index] > activeCore[index];
    }
  }
  return true;
}

function copySnapshot(pluginRoot, snapshotsRoot, fingerprint) {
  const destination = path.join(snapshotsRoot, fingerprint);
  if (fs.existsSync(destination)) return destination;

  const temporary = path.join(
    snapshotsRoot,
    `.${fingerprint}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`
  );
  try {
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    for (const relative of RUNTIME_FILES) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(pluginRoot, relative), target);
      try {
        fs.chmodSync(target, 0o600);
      } catch {}
    }
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
    }
  } finally {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {}
  }
  return destination;
}

function pruneSnapshots(snapshotsRoot, activeSnapshot) {
  let entries;
  try {
    entries = fs
      .readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SNAPSHOT_PATTERN.test(entry.name))
      .map((entry) => {
        const directory = path.join(snapshotsRoot, entry.name);
        return { directory, name: entry.name, mtimeMs: fs.statSync(directory).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  } catch {
    return;
  }
  const keep = new Set([activeSnapshot]);
  for (const entry of entries) {
    if (keep.size >= MAX_RUNTIME_SNAPSHOTS) break;
    keep.add(entry.name);
  }
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    try {
      fs.rmSync(entry.directory, { recursive: true, force: true });
    } catch {}
  }
}

export function ensureStableRuntime({ pluginRoot, pluginData }) {
  if (typeof pluginRoot !== "string" || typeof pluginData !== "string") {
    return { available: false, reason: "runtime_path_unavailable" };
  }
  const sourceRoot = path.resolve(pluginRoot);
  const dataRoot = path.resolve(pluginData);
  if (!fs.existsSync(path.join(sourceRoot, "hooks", "collector.mjs"))) {
    return { available: false, reason: "plugin_root_unavailable" };
  }

  const runtimeRoot = path.join(dataRoot, "runtime");
  const snapshotsRoot = path.join(runtimeRoot, "snapshots");
  fs.mkdirSync(snapshotsRoot, { recursive: true, mode: 0o700 });
  const version = manifestVersion(sourceRoot);
  const fingerprint = runtimeFingerprint(sourceRoot);
  const snapshotPath = copySnapshot(sourceRoot, snapshotsRoot, fingerprint);

  const pointerPath = path.join(runtimeRoot, "active.json");
  let active = null;
  let installedPointer = null;
  try {
    installedPointer = fs.readFileSync(pointerPath, "utf8");
    active = JSON.parse(installedPointer);
  } catch {}
  const activate =
    !SNAPSHOT_PATTERN.test(active?.snapshot || "") ||
    isSameOrNewerVersion(version, typeof active?.version === "string" ? active.version : null);

  const dispatchPath = path.join(runtimeRoot, "dispatch.mjs");
  const dispatchSource = fs.readFileSync(path.join(sourceRoot, "scripts", "runtime-dispatch.mjs"));
  let installedDispatch = null;
  try {
    installedDispatch = fs.readFileSync(dispatchPath);
  } catch {}
  if ((!installedDispatch || activate) && !installedDispatch?.equals(dispatchSource)) {
    atomicWrite(dispatchPath, dispatchSource);
  }

  const pointer = `${JSON.stringify({ schemaVersion: 1, version, snapshot: fingerprint })}\n`;
  if (activate && installedPointer !== pointer) atomicWrite(pointerPath, pointer);
  let activeSnapshot = fingerprint;
  try {
    const current = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (SNAPSHOT_PATTERN.test(current?.snapshot || "")) activeSnapshot = current.snapshot;
  } catch {}
  pruneSnapshots(snapshotsRoot, activeSnapshot);

  return {
    available: true,
    activated: activate,
    version,
    fingerprint,
    activeSnapshot,
    snapshotPath,
    dispatchPath,
    pointerPath,
  };
}
