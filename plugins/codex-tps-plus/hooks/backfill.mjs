#!/usr/bin/env node

// Background Stop hook. Codex writes task_complete after synchronous Stop
// hooks, so this process waits briefly and backfills independently validated,
// redacted completion-duration and TTFT fields into the turn status record.

import {
  backfillTurnCompletion,
  createTurnCompletionReader,
  resolvePluginDataDir,
} from "../scripts/status-core.mjs";
import { isDirectRun } from "../scripts/direct-run.mjs";

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
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
    return {};
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitAndBackfill(input, options = {}) {
  const maxWaitMs = positiveInteger(options.maxWaitMs, 10_000, 30_000);
  const pollMs = positiveInteger(options.pollMs, 100, 1_000);
  const startedAt = Date.now();
  const dataDir = options.dataDir || resolvePluginDataDir(options.env);
  const readCompletion = createTurnCompletionReader(input?.transcript_path, input?.turn_id, {
    maxTailBytes: options.maxTailBytes,
  });
  let lastReason = "turn_not_complete";
  do {
    const completion = readCompletion();
    if (completion.available) {
      const result = backfillTurnCompletion({
        dataDir,
        sessionId: input?.session_id,
        turnId: input?.turn_id,
        completion,
        timingSource: "task_complete_async",
      });
      if (result.updated || result.reason === "already_backfilled") return result;
      lastReason = result.reason;
    } else {
      lastReason = completion.reason;
    }
    if (Date.now() - startedAt >= maxWaitMs) break;
    await delay(pollMs);
  } while (true);
  return { updated: false, reason: lastReason };
}

if (isDirectRun(import.meta.url)) {
  const input = parseInput(await readStdin());
  try {
    await waitAndBackfill(input);
  } catch {
    // Timing is informational. Never fail or steer the turn.
  }
  process.stdout.write("{}");
}
