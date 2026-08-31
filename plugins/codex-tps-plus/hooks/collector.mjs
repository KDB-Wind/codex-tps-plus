#!/usr/bin/env node

// Runtime metrics hook plus opt-in feasibility observer.
// Stop records only hashed identifiers and numeric turn metrics, then surfaces
// an informational throughput line. TPS_PROBE_DIR separately enables the
// redacted phase-one observation files used for compatibility investigations.

import fs from "node:fs";
import {
  captureHookObservation,
  writeObservation,
} from "../scripts/probe-core.mjs";
import { ensureStableRuntime } from "../scripts/runtime-snapshot.mjs";
import { captureStopStatus } from "../scripts/status-core.mjs";

const TRANSCRIPT_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Stop",
]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function readStdin() {
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", () => resolve(value));
  });
}

function parseInput(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { __parseError: true };
  }
}

function outputFor(eventName, statusLine = null) {
  if (eventName === "Stop" && statusLine) {
    return { systemMessage: statusLine };
  }
  if (eventName === "UserPromptSubmit") {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "",
      },
    };
  }
  return {};
}

const eventName = process.argv[2] || "Unknown";
const input = parseInput(await readStdin());
try {
  ensureStableRuntime({
    pluginRoot: process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT,
    pluginData: process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA,
  });
} catch {}
const outputDir = process.env.TPS_PROBE_DIR?.trim();
let statusLine = null;

if (eventName === "Stop") {
  try {
    statusLine = captureStopStatus(input).line;
  } catch {
    // Metrics are informational. A parsing or persistence failure must not
    // request continuation or block the turn.
  }
}

if (outputDir) {
  try {
    const observation = captureHookObservation({
      eventName,
      input,
      includeTranscript: TRANSCRIPT_EVENTS.has(eventName),
    });
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    writeObservation(outputDir, observation, {
      maxFiles: positiveInteger(process.env.TPS_PROBE_MAX_FILES, 500),
      maxBytes: positiveInteger(process.env.TPS_PROBE_MAX_BYTES, 64 * 1024 * 1024),
    });
  } catch {
    // This observer never steers a turn. Codex may still report process-level
    // failures such as a timeout or an unavailable Node executable.
  }
}

// Stop requires valid JSON on stdout when the process exits successfully.
process.stdout.write(JSON.stringify(outputFor(eventName, statusLine)));
