#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assessOtelCaptureIsolation,
  assessOtelExporter,
  selectPluginInstallation,
} from "./doctor-core.mjs";
import { inspectOtelCapture } from "./otel-inspect.mjs";
import { inspectOtelConfig } from "./otel.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
const hooksPath = path.join(root, "hooks", "hooks.json");

function check(name, ok, detail, hint = null) {
  return { name, ok, detail, hint };
}

function runCodex(args) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex", ...args], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  }
  return spawnSync("codex", args, { encoding: "utf8", shell: false });
}

function codexVersion() {
  const result = runCodex(["--version"]);
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  const version = match ? match[0] : null;
  const ok = Boolean(match && Number(match[1]) >= 0);
  return check("Codex CLI", ok, version ? `${version} (${output.split(/\r?\n/)[0]})` : output || "not found");
}

function pluginInstallation(version) {
  const result = runCodex(["plugin", "list", "--json"]);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  let selected = null;
  try {
    selected = selectPluginInstallation(JSON.parse(result.stdout || "{}").installed, version);
  } catch {}
  const detail = selected
    ? `${selected.pluginId}  installed, enabled  ${selected.version}  ${selected.source?.path || "source unavailable"}`
    : "codex-tps-plus not listed";
  return check(
    "Plugin installation",
    Boolean(selected),
    selected ? detail : output.trim() || detail,
    selected
      ? null
      : "Add a marketplace, install codex-tps-plus from it, then review the plugin in /hooks."
  );
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const results = [];
const manifest = loadJson(manifestPath);
const [major, minor] = process.versions.node.split(".").map(Number);
results.push(
  check(
    "Node.js",
    major > 22 || (major === 22 && minor >= 5),
    process.versions.node,
    "The plugin requires Node >= 22.5."
  )
);
results.push(codexVersion());
results.push(pluginInstallation(manifest?.version));

results.push(
  check(
    "Plugin manifest",
    Boolean(manifest?.name === "codex-tps-plus" && manifest?.skills === "./skills/"),
    fs.existsSync(manifestPath) ? "present and named codex-tps-plus" : "missing or invalid"
  )
);

const hooks = loadJson(hooksPath);
const hookNames = Object.keys(hooks?.hooks || {});
const stopHandlers = Array.isArray(hooks?.hooks?.Stop)
  ? hooks.hooks.Stop.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
  : [];
const syncCollector = stopHandlers.find(
  (handler) => typeof handler?.command === "string" && handler.command.includes("collector.mjs")
);
const asyncBackfill = stopHandlers.find(
  (handler) => typeof handler?.command === "string" && handler.command.includes("backfill.mjs")
);
const releaseHookConfig =
  hookNames.length === 1 &&
  hookNames[0] === "Stop" &&
  stopHandlers.length === 2 &&
  syncCollector?.async !== true &&
  asyncBackfill?.async === true;
results.push(
  check(
    "Hook configuration",
    releaseHookConfig,
    releaseHookConfig
      ? "Stop: synchronous display + asynchronous TTFT backfill"
      : hookNames.join(", ") || "missing",
    releaseHookConfig
      ? null
      : "The release plugin should register only Stop with the sync collector and async TTFT backfill."
  )
);

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const userConfig = path.resolve(option("--config") || path.join(codexHome, "config.toml"));
let configText = "";
try {
  configText = fs.readFileSync(userConfig, "utf8");
} catch {}
const bearerCount = (configText.match(/experimental_bearer_token\s*=/g) || []).length;
results.push(
  check(
    "Credential override guard",
    bearerCount === 0,
    bearerCount === 0 ? "no experimental_bearer_token setting found" : `${bearerCount} setting(s) found; values omitted`,
    bearerCount === 0 ? null : "Remove stale bearer-token settings before using account authentication."
  )
);

const otel = inspectOtelConfig(userConfig);
results.push(
  check(
    "OpenTelemetry configuration",
    true,
    otel.otelSectionPresent
      ? `section present; logs=${otel.exporter || "none"}; metrics=${otel.metricsExporter || "default"}`
      : "not configured (expected default)",
    "OTel is opt-in; use the local receiver only for an explicit feasibility run."
  )
);

const otelCapture = option("--otel-capture") || process.env.TPS_PLUS_OTEL_CAPTURE_DIR?.trim();
if (otelCapture) {
  let capture = null;
  try {
    capture = inspectOtelCapture(path.resolve(otelCapture));
  } catch {}
  const exporter = assessOtelExporter(otel, capture?.receiver);
  const isolation = assessOtelCaptureIsolation(capture);
  results.push(
    check(
      "OTel local receiver",
      isolation.receiverExclusive,
      isolation.receiverExclusive
        ? "active, loopback-only, and the capture has one receiver identity"
        : capture?.directoryPresent
          ? "not active or the capture has multiple receiver identities"
          : "capture directory unavailable",
      "Start one explicit local receiver for this capture directory; production hooks never start it automatically."
    )
  );
  results.push(
    check(
      "OTel logs exporter",
      exporter.logsMatchReceiver,
      exporter.logsMatchReceiver
        ? "configured loopback endpoint matches the active receiver"
        : exporter.logsConfigured
          ? "configured endpoint does not match the active receiver"
          : "logs exporter is not configured",
      "The logs stream is required to detect concurrent conversations; keep log_user_prompt=false."
    )
  );
  results.push(
    check(
      "OTel metrics exporter",
      exporter.matchesReceiver,
      exporter.matchesReceiver
        ? "configured loopback endpoint matches the active receiver"
        : exporter.configured
          ? "configured endpoint does not match the active receiver"
          : "metrics exporter is not configured",
      "Point [otel].metrics_exporter at the receiver's /v1/metrics endpoint for the experiment."
    )
  );
  results.push(
    check(
      "OTel capture isolation",
      !isolation.concurrentContamination,
      isolation.concurrentContamination
        ? `contaminated; ${capture?.captureIsolation?.distinctConversationCount || 0} conversations or multiple receivers observed`
        : `${isolation.conversationIsolation}; this does not prove single-turn attribution`,
      isolation.concurrentContamination
        ? "Use a fresh capture directory and ensure only one Codex session exports to it."
        : null
    )
  );
}

const report = { doctorVersion: 1, root, checks: results, failed: results.filter((item) => !item.ok).length };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const item of results) {
    console.log(`${item.ok ? "OK" : "FAIL"} ${item.name}: ${item.detail}`);
    if (item.hint) console.log(`  -> ${item.hint}`);
  }
  console.log(report.failed ? `${report.failed} check(s) failed` : "All checks passed");
}
process.exitCode = report.failed ? 1 : 0;
