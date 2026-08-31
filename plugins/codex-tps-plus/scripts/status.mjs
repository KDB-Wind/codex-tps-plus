#!/usr/bin/env node

import path from "node:path";
import { inspectOtelCapture } from "./otel-inspect.mjs";
import {
  formatStatusLine,
  nativeOtelReferenceFromInspection,
  readSessionStatus,
  resolvePluginDataDir,
} from "./status-core.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const dataDir = option("--data-dir") || resolvePluginDataDir();
const sessionId = option("--session-id") || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
let status = sessionId
  ? readSessionStatus({ dataDir, sessionId })
  : { available: false, reason: "session_id_unavailable" };
const otelCapture = option("--otel-capture") || process.env.TPS_PLUS_OTEL_CAPTURE_DIR?.trim();
if (otelCapture) {
  try {
    status = {
      ...status,
      nativeOtel: nativeOtelReferenceFromInspection(
        inspectOtelCapture(path.resolve(otelCapture))
      ),
    };
  } catch {
    status = { ...status, nativeOtel: { available: false, reason: "capture_unreadable" } };
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} else {
  process.stdout.write(`${formatStatusLine(status, "上轮整轮吞吐") || "暂无本会话吞吐数据；完成一轮对话后再试。"}\n`);
}
