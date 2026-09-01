import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUS_SCHEMA_VERSION = 5;
const SHORT_RESPONSE_TOKENS_PER_REQUEST = 128;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_TURN_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_FILES = 200;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const STATUS_FILE_PATTERN = /^\d+-[0-9a-f]{12}-[0-9a-f]{10}\.json$/;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function hashId(value) {
  if (typeof value !== "string" || !value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function usageFrom(payload) {
  const usage = payload?.info?.last_token_usage;
  if (!usage || typeof usage !== "object") return null;
  const outputTokens = finiteNumber(usage.output_tokens);
  const reasoningTokens = finiteNumber(usage.reasoning_output_tokens);
  const totalOutputTokens = finiteNumber(payload?.info?.total_token_usage?.output_tokens);
  if (outputTokens === null || outputTokens < 0) return null;
  return {
    outputTokens,
    reasoningTokens: reasoningTokens !== null && reasoningTokens >= 0 ? reasoningTokens : null,
    totalOutputTokens: totalOutputTokens !== null && totalOutputTokens >= 0 ? totalOutputTokens : null,
  };
}

function timestampMs(record, fallbackSeconds = null) {
  const parsed = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const seconds = finiteNumber(fallbackSeconds);
  return seconds === null ? null : seconds * 1000;
}

export function readTail(file, byteLimit, fileSystem = fs) {
  const stat = fileSystem.statSync(file);
  const length = Math.min(stat.size, byteLimit);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.allocUnsafe(length);
  const handle = fileSystem.openSync(file, "r");
  let bytesRead = 0;
  try {
    bytesRead = fileSystem.readSync(handle, buffer, 0, length, start);
  } finally {
    fileSystem.closeSync(handle);
  }
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  return { text, start, sizeBytes: stat.size };
}

function scanCurrentTurn(text, currentTurnId) {
  let activeTurnId = null;
  let startedAtMs = null;
  let foundStart = false;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reasoningKnown = true;
  let tokenCountEvents = 0;
  let duplicateTokenCountEvents = 0;
  let toolCallCount = 0;
  let parseErrorCount = 0;
  let requestStartAtMs = null;
  let latestModelActivityAtMs = null;
  let requestDurationMs = 0;
  let estimatedOutputTokens = 0;
  let estimatedRequestCount = 0;
  let unestimatedRequestCount = 0;
  const seenCumulativeOutput = new Set();
  const seenFallbackUsage = new Set();

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      if (activeTurnId === currentTurnId) {
        foundStart = true;
        startedAtMs = timestampMs(record, payload.started_at);
        outputTokens = 0;
        reasoningTokens = 0;
        reasoningKnown = true;
        tokenCountEvents = 0;
        duplicateTokenCountEvents = 0;
        toolCallCount = 0;
        requestStartAtMs = startedAtMs;
        latestModelActivityAtMs = null;
        requestDurationMs = 0;
        estimatedOutputTokens = 0;
        estimatedRequestCount = 0;
        unestimatedRequestCount = 0;
        seenCumulativeOutput.clear();
        seenFallbackUsage.clear();
      }
      continue;
    }
    if (payload.type === "task_complete") {
      if (payload.turn_id === activeTurnId || !payload.turn_id) activeTurnId = null;
      continue;
    }
    if (!foundStart || activeTurnId !== currentTurnId) continue;
    if (record.type === "response_item") {
      const isAssistantMessage = payload.type === "message" && payload.role === "assistant";
      const isModelActivity = isAssistantMessage || [
        "reasoning",
        "function_call",
        "custom_tool_call",
        "local_shell_call",
        "mcp_tool_call",
        "web_search_call",
      ].includes(payload.type);
      if (isModelActivity) {
        const activityAtMs = timestampMs(record);
        if (activityAtMs !== null) latestModelActivityAtMs = activityAtMs;
      }
    }
    if (payload.type === "token_count") {
      const usage = usageFrom(payload);
      if (!usage) continue;
      const fallbackKey = `${usage.outputTokens}:${usage.reasoningTokens ?? "?"}`;
      const duplicate = usage.totalOutputTokens !== null
        ? seenCumulativeOutput.has(usage.totalOutputTokens)
        : seenFallbackUsage.has(fallbackKey);
      if (duplicate) {
        duplicateTokenCountEvents += 1;
        continue;
      }
      if (usage.totalOutputTokens !== null) seenCumulativeOutput.add(usage.totalOutputTokens);
      else seenFallbackUsage.add(fallbackKey);
      const tokenCountAtMs = timestampMs(record);
      const responseEndAtMs = latestModelActivityAtMs ?? tokenCountAtMs;
      if (
        usage.outputTokens > 0 &&
        requestStartAtMs !== null &&
        responseEndAtMs !== null &&
        responseEndAtMs > requestStartAtMs
      ) {
        const intervalDurationMs = responseEndAtMs - requestStartAtMs;
        if (intervalDurationMs <= MAX_TURN_DURATION_MS) {
          requestDurationMs += intervalDurationMs;
          estimatedOutputTokens += usage.outputTokens;
          estimatedRequestCount += 1;
        } else {
          unestimatedRequestCount += 1;
        }
      } else if (usage.outputTokens > 0) {
        unestimatedRequestCount += 1;
      }
      outputTokens += usage.outputTokens;
      if (usage.reasoningTokens === null) reasoningKnown = false;
      else reasoningTokens += usage.reasoningTokens;
      tokenCountEvents += 1;
      if (tokenCountAtMs !== null) requestStartAtMs = tokenCountAtMs;
      latestModelActivityAtMs = null;
    }
    if (
      record.type === "response_item" &&
      ["function_call", "custom_tool_call", "local_shell_call", "mcp_tool_call"].includes(payload.type)
    ) {
      toolCallCount += 1;
    }
  }

  return {
    foundStart,
    startedAtMs,
    outputTokens,
    reasoningTokens: reasoningKnown ? reasoningTokens : null,
    tokenCountEvents,
    duplicateTokenCountEvents,
    toolCallCount,
    parseErrorCount,
    requestDurationMs,
    estimatedOutputTokens,
    estimatedRequestCount,
    unestimatedRequestCount,
  };
}

function scanTurnCompletion(text, currentTurnId) {
  let activeTurnId = null;
  let parseErrorCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      continue;
    }
    if (payload.type !== "task_complete") continue;
    const completedTurnId =
      typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : activeTurnId;
    if (completedTurnId === currentTurnId) {
      return {
        found: true,
        ttftMs: finiteNumber(payload.time_to_first_token_ms),
        completedDurationMs: finiteNumber(payload.duration_ms),
        parseErrorCount,
      };
    }
    if (completedTurnId === activeTurnId) activeTurnId = null;
  }
  return { found: false, parseErrorCount };
}

function scanPreviousTurnCompletion(text, currentTurnId) {
  let activeTurnId = null;
  let previous = null;
  let foundCurrentStart = false;
  let parseErrorCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      if (activeTurnId === currentTurnId) {
        foundCurrentStart = true;
        break;
      }
      continue;
    }
    if (payload.type !== "task_complete") continue;
    const completedTurnId =
      typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : activeTurnId;
    if (completedTurnId && completedTurnId !== currentTurnId) {
      previous = {
        turnId: completedTurnId,
        ttftMs: finiteNumber(payload.time_to_first_token_ms),
        completedDurationMs: finiteNumber(payload.duration_ms),
      };
    }
    if (completedTurnId === activeTurnId) activeTurnId = null;
  }
  return { foundCurrentStart, previous, parseErrorCount };
}

export function extractTurnCompletion(transcriptPath, currentTurnId, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { available: false, reason: "transcript_not_provided" };
  }
  if (typeof currentTurnId !== "string" || !currentTurnId) {
    return { available: false, reason: "turn_not_provided" };
  }
  const maxTailBytes = Math.max(
    INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES)
  );
  let byteLimit = Math.min(INITIAL_TAIL_BYTES, maxTailBytes);
  let tail;
  let scanned;
  try {
    for (;;) {
      tail = readTail(transcriptPath, byteLimit);
      scanned = scanTurnCompletion(tail.text, currentTurnId);
      if (scanned.found || tail.start === 0 || byteLimit >= maxTailBytes) break;
      byteLimit = Math.min(byteLimit * 2, maxTailBytes);
    }
  } catch {
    return { available: false, reason: "transcript_unreadable" };
  }
  if (!scanned.found) {
    return {
      available: false,
      reason: tail.start > 0 ? "turn_exceeds_tail_limit_or_not_complete" : "turn_not_complete",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  const ttftMs = scanned.ttftMs;
  const completedDurationMs = scanned.completedDurationMs;
  if (ttftMs === null || ttftMs < 0 || ttftMs > MAX_TURN_DURATION_MS) {
    return { available: false, reason: "ttft_missing_or_invalid" };
  }
  if (
    completedDurationMs !== null &&
    (completedDurationMs <= 0 ||
      completedDurationMs > MAX_TURN_DURATION_MS ||
      ttftMs > completedDurationMs)
  ) {
    return { available: false, reason: "completion_duration_invalid" };
  }
  return {
    available: true,
    source: "transcript-task-complete-delayed",
    ttftMs,
    completedDurationMs,
    parseErrorCount: scanned.parseErrorCount,
    scannedBytes: tail.sizeBytes - tail.start,
  };
}

export function extractPreviousTurnCompletion(transcriptPath, currentTurnId, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { available: false, reason: "transcript_not_provided" };
  }
  if (typeof currentTurnId !== "string" || !currentTurnId) {
    return { available: false, reason: "turn_not_provided" };
  }
  const maxTailBytes = Math.max(
    INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES)
  );
  let byteLimit = Math.min(INITIAL_TAIL_BYTES, maxTailBytes);
  let tail;
  let scanned;
  try {
    for (;;) {
      tail = readTail(transcriptPath, byteLimit);
      scanned = scanPreviousTurnCompletion(tail.text, currentTurnId);
      if (
        (scanned.foundCurrentStart && scanned.previous) ||
        tail.start === 0 ||
        byteLimit >= maxTailBytes
      ) {
        break;
      }
      byteLimit = Math.min(byteLimit * 2, maxTailBytes);
    }
  } catch {
    return { available: false, reason: "transcript_unreadable" };
  }
  if (!scanned.foundCurrentStart) {
    return {
      available: false,
      reason: tail.start > 0 ? "current_turn_exceeds_tail_limit" : "current_turn_not_found",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  if (!scanned.previous) {
    return {
      available: false,
      reason: tail.start > 0 ? "previous_turn_exceeds_tail_limit" : "previous_turn_not_found",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  const { turnId, ttftMs, completedDurationMs } = scanned.previous;
  if (ttftMs === null || ttftMs < 0 || ttftMs > MAX_TURN_DURATION_MS) {
    return { available: false, reason: "ttft_missing_or_invalid" };
  }
  if (
    completedDurationMs !== null &&
    (completedDurationMs <= 0 ||
      completedDurationMs > MAX_TURN_DURATION_MS ||
      ttftMs > completedDurationMs)
  ) {
    return { available: false, reason: "completion_duration_invalid" };
  }
  return {
    available: true,
    source: "transcript-task-complete-delayed",
    turnId,
    ttftMs,
    completedDurationMs,
    parseErrorCount: scanned.parseErrorCount,
    scannedBytes: tail.sizeBytes - tail.start,
  };
}

export function extractStopMetric(transcriptPath, currentTurnId, options = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { available: false, reason: "transcript_not_provided" };
  }
  if (typeof currentTurnId !== "string" || !currentTurnId) {
    return { available: false, reason: "turn_not_provided" };
  }

  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const maxTailBytes = Math.max(
    INITIAL_TAIL_BYTES,
    Math.min(finiteNumber(options.maxTailBytes) ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES)
  );
  let byteLimit = Math.min(INITIAL_TAIL_BYTES, maxTailBytes);
  let tail;
  let scanned;
  try {
    for (;;) {
      tail = readTail(transcriptPath, byteLimit);
      scanned = scanCurrentTurn(tail.text, currentTurnId);
      if (scanned.foundStart || tail.start === 0 || byteLimit >= maxTailBytes) break;
      byteLimit = Math.min(byteLimit * 2, maxTailBytes);
    }
  } catch {
    return { available: false, reason: "transcript_unreadable" };
  }

  if (!scanned.foundStart) {
    return {
      available: false,
      reason: tail.start > 0 ? "turn_exceeds_tail_limit" : "turn_not_found",
      scannedBytes: tail.sizeBytes - tail.start,
    };
  }
  if (scanned.startedAtMs === null) {
    return { available: false, reason: "turn_start_time_missing" };
  }
  if (scanned.tokenCountEvents === 0 || scanned.outputTokens <= 0) {
    return { available: false, reason: "output_tokens_missing" };
  }
  const durationMs = nowMs - scanned.startedAtMs;
  if (durationMs <= 0 || durationMs > MAX_TURN_DURATION_MS) {
    return { available: false, reason: "turn_duration_invalid" };
  }

  return {
    available: true,
    source: "transcript-request-intervals-including-ttft",
    outputTokens: scanned.outputTokens,
    reasoningTokens: scanned.reasoningTokens,
    durationMs,
    throughput: scanned.outputTokens / (durationMs / 1000),
    requestThroughput:
      scanned.requestDurationMs > 0 && scanned.estimatedOutputTokens > 0
        ? scanned.estimatedOutputTokens / (scanned.requestDurationMs / 1000)
        : null,
    requestDurationMs: scanned.requestDurationMs || null,
    estimatedOutputTokens: scanned.estimatedOutputTokens,
    estimatedRequestCount: scanned.estimatedRequestCount,
    unestimatedRequestCount: scanned.unestimatedRequestCount,
    tokenCountEvents: scanned.tokenCountEvents,
    duplicateTokenCountEvents: scanned.duplicateTokenCountEvents,
    toolCallCount: scanned.toolCallCount,
    parseErrorCount: scanned.parseErrorCount,
    scannedBytes: tail.sizeBytes - tail.start,
  };
}

export function resolvePluginDataDir(env = process.env) {
  const explicit = env.TPS_PLUS_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim();
  if (explicit) return explicit;
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "plugins", "data", "codex-tps-plus-personal");
}

function sessionDirectory(dataDir, sessionId) {
  const sessionHash = hashId(sessionId);
  return sessionHash ? path.join(dataDir, "status", sessionHash) : null;
}

function hasCompleteRequestMeasurement(record) {
  return (
    finiteNumber(record?.estimatedOutputTokens) > 0 &&
    finiteNumber(record?.estimatedRequestCount) > 0 &&
    finiteNumber(record?.requestDurationMs ?? record?.inferenceDurationMs) > 0 &&
    (finiteNumber(record?.unestimatedRequestCount) ?? 0) === 0
  );
}

function readStatusRecords(directory) {
  let entries;
  try {
    entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && STATUS_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const stat = fs.statSync(file);
        return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  } catch {
    return [];
  }

  const byTurn = new Map();
  for (const entry of entries) {
    try {
      const record = JSON.parse(fs.readFileSync(entry.file, "utf8"));
      if (
        [1, 2, 3, 4, STATUS_SCHEMA_VERSION].includes(record?.schemaVersion) &&
        typeof record.turnId === "string" &&
        finiteNumber(record.outputTokens) > 0 &&
        finiteNumber(record.durationMs) > 0
      ) {
        byTurn.set(record.turnId, { ...record, __entry: entry });
      }
    } catch {}
  }
  return [...byTurn.values()].sort((left, right) => {
    const leftTime = Date.parse(left.capturedAt);
    const rightTime = Date.parse(right.capturedAt);
    const safeLeft = Number.isFinite(leftTime) ? leftTime : left.__entry.mtimeMs;
    const safeRight = Number.isFinite(rightTime) ? rightTime : right.__entry.mtimeMs;
    return safeLeft - safeRight || left.__entry.name.localeCompare(right.__entry.name);
  });
}

export function pruneStatusFiles(directory, fileSystem = fs) {
  let files;
  try {
    files = fileSystem
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && STATUS_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const stat = fileSystem.statSync(file);
        return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  } catch {
    return;
  }
  let bytes = files.reduce((total, entry) => total + entry.size, 0);
  while (files.length > MAX_SESSION_FILES || bytes > MAX_SESSION_BYTES) {
    const oldest = files.shift();
    if (!oldest) break;
    bytes -= oldest.size;
    try {
      fileSystem.unlinkSync(oldest.file);
    } catch {}
  }
}

export function summarizeStatusRecords(records) {
  const valid = (records || []).filter(
    (record) => finiteNumber(record.outputTokens) > 0 && finiteNumber(record.durationMs) > 0
  );
  const outputTokens = valid.reduce((total, record) => total + record.outputTokens, 0);
  const durationMs = valid.reduce((total, record) => total + record.durationMs, 0);
  const latest = valid.at(-1) || null;
  const requestMeasured = valid.filter(hasCompleteRequestMeasurement);
  const requestOutputTokens = requestMeasured.reduce(
    (total, record) => total + record.estimatedOutputTokens,
    0
  );
  const requestDurationMs = requestMeasured.reduce(
    (total, record) => total + (record.requestDurationMs ?? record.inferenceDurationMs),
    0
  );
  const latestRequestDurationMs = latest?.requestDurationMs ?? latest?.inferenceDurationMs ?? null;
  const latestEstimatedRequestCount = finiteNumber(latest?.estimatedRequestCount) ?? 0;
  const latestRequestCoverageComplete = latest ? hasCompleteRequestMeasurement(latest) : false;
  const latestMeanOutputTokensPerRequest =
    finiteNumber(latest?.estimatedOutputTokens) > 0 && latestEstimatedRequestCount > 0
      ? latest.estimatedOutputTokens / latestEstimatedRequestCount
      : null;
  const ttftMeasured = valid.filter((record) => {
    const ttftMs = finiteNumber(record?.ttftMs);
    return ttftMs !== null && ttftMs >= 0;
  });
  const latestTtftRecord = ttftMeasured.at(-1) || null;
  const ttftTotalMs = ttftMeasured.reduce((total, record) => total + finiteNumber(record.ttftMs), 0);
  return {
    available: Boolean(latest),
    metric: latestRequestCoverageComplete
      ? "model_request_throughput_including_ttft"
      : "end_to_end_turn_throughput",
    isPureGenerationTps: false,
    requestThroughputIncludesTtft: latestRequestCoverageComplete,
    requestThroughputMethod: latestRequestCoverageComplete
      ? "transcript-model-request-intervals-including-ttft"
      : null,
    turns: valid.length,
    latest: latest
      ? {
          outputTokens: latest.outputTokens,
          reasoningTokens: latest.reasoningTokens ?? null,
          durationMs: latest.durationMs,
          throughput: latest.outputTokens / (latest.durationMs / 1000),
          requestThroughput:
            latestRequestCoverageComplete
              ? latest.estimatedOutputTokens / (latestRequestDurationMs / 1000)
              : null,
          requestCoverageComplete: latestRequestCoverageComplete,
          requestDurationMs: latestRequestDurationMs,
          estimatedOutputTokens: latest.estimatedOutputTokens ?? 0,
          estimatedRequestCount: latestEstimatedRequestCount,
          meanOutputTokensPerRequest: latestMeanOutputTokensPerRequest,
          shortResponseReference:
            latestRequestCoverageComplete &&
            latestMeanOutputTokensPerRequest !== null &&
            latestMeanOutputTokensPerRequest < SHORT_RESPONSE_TOKENS_PER_REQUEST,
          unestimatedRequestCount: latest.unestimatedRequestCount ?? 0,
          tokenCountEvents: latest.tokenCountEvents,
          duplicateTokenCountEvents: latest.duplicateTokenCountEvents ?? 0,
          toolCallCount: latest.toolCallCount,
          ttftMs: finiteNumber(latest.ttftMs),
          completedDurationMs: finiteNumber(latest.completedDurationMs),
          timingSource: typeof latest.timingSource === "string" ? latest.timingSource : null,
          capturedAt: latest.capturedAt,
        }
      : null,
    session: latest
      ? {
          outputTokens,
          durationMs,
          throughput: outputTokens / (durationMs / 1000),
          requestThroughput:
            requestOutputTokens > 0 && requestDurationMs > 0
              ? requestOutputTokens / (requestDurationMs / 1000)
              : null,
          requestOutputTokens,
          requestDurationMs,
          requestMeasuredTurns: requestMeasured.length,
          ttftMeasuredTurns: ttftMeasured.length,
          ttftMeanMs: ttftMeasured.length ? ttftTotalMs / ttftMeasured.length : null,
        }
      : null,
    mostRecentTtft: latestTtftRecord
      ? {
          ttftMs: finiteNumber(latestTtftRecord.ttftMs),
          completedDurationMs: finiteNumber(latestTtftRecord.completedDurationMs),
          timingSource:
            typeof latestTtftRecord.timingSource === "string"
              ? latestTtftRecord.timingSource
              : null,
          isLatestTurn: latestTtftRecord.turnId === latest?.turnId,
          capturedAt: latestTtftRecord.capturedAt,
        }
      : null,
  };
}

export function readSessionStatus({ dataDir, sessionId }) {
  const directory = sessionDirectory(dataDir, sessionId);
  if (!directory) return summarizeStatusRecords([]);
  return summarizeStatusRecords(readStatusRecords(directory));
}

export function recordStopMetric({ dataDir, sessionId, turnId, metric, capturedAt = new Date() }) {
  if (!metric?.available) return readSessionStatus({ dataDir, sessionId });
  const directory = sessionDirectory(dataDir, sessionId);
  const turnHash = hashId(turnId);
  if (!directory || !turnHash) return summarizeStatusRecords([]);

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const name = `${safeTimestamp}-${turnHash}-${crypto.randomBytes(5).toString("hex")}.json`;
  const finalPath = path.join(directory, name);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  const record = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    capturedAt: new Date(safeTimestamp).toISOString(),
    turnId: turnHash,
    source: metric.source,
    outputTokens: metric.outputTokens,
    reasoningTokens: metric.reasoningTokens,
    durationMs: metric.durationMs,
    requestDurationMs: metric.requestDurationMs,
    estimatedOutputTokens: metric.estimatedOutputTokens,
    estimatedRequestCount: metric.estimatedRequestCount,
    unestimatedRequestCount: metric.unestimatedRequestCount,
    tokenCountEvents: metric.tokenCountEvents,
    duplicateTokenCountEvents: metric.duplicateTokenCountEvents,
    toolCallCount: metric.toolCallCount,
  };
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
  pruneStatusFiles(directory);
  return readSessionStatus({ dataDir, sessionId });
}

function writeReplacementStatusRecord(directory, turnHash, record, nowMs = Date.now()) {
  const name = `${nowMs}-${turnHash}-${crypto.randomBytes(5).toString("hex")}.json`;
  const finalPath = path.join(directory, name);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
  return finalPath;
}

export function backfillTurnCompletion({
  dataDir,
  sessionId,
  turnId,
  completion,
  timingSource = "task_complete_direct",
  capturedAt = new Date(),
}) {
  if (!completion?.available) return { updated: false, reason: completion?.reason || "unavailable" };
  const directory = sessionDirectory(dataDir, sessionId);
  const turnHash = hashId(turnId);
  if (!directory || !turnHash) return { updated: false, reason: "session_or_turn_missing" };
  const matching = readStatusRecords(directory).filter((record) => record.turnId === turnHash);
  const current = matching.at(-1);
  if (!current) return { updated: false, reason: "status_record_not_ready" };
  if (
    finiteNumber(current.ttftMs) === completion.ttftMs &&
    finiteNumber(current.completedDurationMs) === completion.completedDurationMs
  ) {
    return { updated: false, reason: "already_backfilled" };
  }

  const timingCapturedAt = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  const safeTimingCapturedAt = Number.isFinite(timingCapturedAt.getTime())
    ? timingCapturedAt
    : new Date();
  const replacement = { ...current };
  delete replacement.__entry;
  Object.assign(replacement, {
    schemaVersion: STATUS_SCHEMA_VERSION,
    ttftMs: completion.ttftMs,
    completedDurationMs: completion.completedDurationMs,
    timingSource,
    timingCapturedAt: safeTimingCapturedAt.toISOString(),
  });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = writeReplacementStatusRecord(
    directory,
    turnHash,
    replacement,
    safeTimingCapturedAt.getTime()
  );
  for (const record of matching) {
    if (record.__entry?.file === finalPath) continue;
    try {
      fs.unlinkSync(record.__entry.file);
    } catch {}
  }
  pruneStatusFiles(directory);
  return { updated: true, status: readSessionStatus({ dataDir, sessionId }) };
}

export function nativeOtelReferenceFromInspection(inspection) {
  const timing = inspection?.nativeTiming;
  const tbt = timing?.serviceTbt;
  const meanTbtMs = finiteNumber(tbt?.meanMs);
  const observations = finiteNumber(tbt?.observations);
  const approximateTps = finiteNumber(timing?.approximateTpsFromServiceTbt);
  const outputTokens = finiteNumber(timing?.tokenUsage?.output?.sum);
  const turnsObserved = finiteNumber(timing?.turnE2e?.observations);
  if (
    meanTbtMs === null ||
    meanTbtMs <= 0 ||
    observations === null ||
    observations <= 0 ||
    approximateTps === null ||
    approximateTps <= 0
  ) {
    return { available: false, reason: "service_tbt_not_observed" };
  }
  return {
    available: true,
    source: "codex-native-otel-engine-timing",
    confidence: inspection?.captureIsolation?.singleTurnCandidateEligible
      ? "isolated-window-candidate"
      : "capture-aggregate",
    scope: inspection?.captureIsolation?.singleTurnCandidateEligible
      ? "isolated_single_turn_capture_unattributed_to_live_stop"
      : "capture_aggregate_unattributed",
    serviceTbtMeanMs: meanTbtMs,
    observations,
    outputTokens,
    turnsObserved,
    shortOutputReference:
      outputTokens !== null && turnsObserved !== null && turnsObserved > 0
        ? outputTokens / turnsObserved < SHORT_RESPONSE_TOKENS_PER_REQUEST
        : null,
    approximateTps,
    currentTurnAttributed: false,
    exactPerRequestTps: false,
    perRequestJoinable: Boolean(inspection?.perRequestJoinable),
    rawCaptureSensitive: Boolean(inspection?.rawCaptureSensitive),
  };
}

function compactNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function compactDuration(durationMs) {
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function formatStatusLine(status, label = "整轮吞吐") {
  if (!status?.available || !status.latest || !status.session) return null;
  const ttft = status.mostRecentTtft;
  const ttftSuffix = ttft
    ? ` · ${ttft.isLatestTurn ? "TTFT" : "上轮 TTFT"} ${compactDuration(ttft.ttftMs)}`
    : "";
  const nativeOtelSuffix = status.nativeOtel?.available
    ? ` · 原生生成 TPS ≈${status.nativeOtel.approximateTps.toFixed(1)}（TBT 推算·${
        status.nativeOtel.confidence === "isolated-window-candidate" ? "单轮候选" : "捕获参考"
      }·未归轮${status.nativeOtel.shortOutputReference ? "·短输出" : ""}）`
    : "";
  if (status.latest.requestThroughput && status.session.requestThroughput) {
    const qualifier = status.latest.shortResponseReference
      ? "（含首字·短回复参考）"
      : "（含首字）";
    return `⚡ 请求内吞吐 ${status.latest.requestThroughput.toFixed(1)} tok/s${qualifier} · 会话请求内 ${status.session.requestThroughput.toFixed(1)} tok/s · 整轮 ${status.latest.throughput.toFixed(1)} tok/s · 输出 ${compactNumber(status.latest.outputTokens)} tok · 轮耗时 ${compactDuration(status.latest.durationMs)}${ttftSuffix}${nativeOtelSuffix}`;
  }
  return `⚡ ${label} ${status.latest.throughput.toFixed(1)} tok/s · 会话吞吐 ${status.session.throughput.toFixed(1)} tok/s · 输出 ${compactNumber(status.latest.outputTokens)} tok · 耗时 ${compactDuration(status.latest.durationMs)}${ttftSuffix}${nativeOtelSuffix}`;
}

export function captureStopStatus(input, options = {}) {
  const dataDir = options.dataDir || resolvePluginDataDir(options.env);
  const capturedAt = new Date(finiteNumber(options.nowMs) ?? Date.now());
  let previousTurnBackfill = { updated: false, reason: "previous_turn_not_available" };
  try {
    const previousCompletion = extractPreviousTurnCompletion(
      input?.transcript_path,
      input?.turn_id,
      { maxTailBytes: options.maxTailBytes }
    );
    previousTurnBackfill = previousCompletion.available
      ? backfillTurnCompletion({
          dataDir,
          sessionId: input?.session_id,
          turnId: previousCompletion.turnId,
          completion: previousCompletion,
          timingSource: "task_complete_sync_recovery",
          capturedAt,
        })
      : { updated: false, reason: previousCompletion.reason };
  } catch {
    previousTurnBackfill = { updated: false, reason: "previous_turn_backfill_failed" };
  }
  const metric = extractStopMetric(input?.transcript_path, input?.turn_id, {
    nowMs: options.nowMs,
    maxTailBytes: options.maxTailBytes,
  });
  if (!metric.available) {
    return {
      metric,
      status: previousTurnBackfill.status || null,
      line: null,
      previousTurnBackfill,
    };
  }
  const status = recordStopMetric({
    dataDir,
    sessionId: input?.session_id,
    turnId: input?.turn_id,
    metric,
    capturedAt,
  });
  return { metric, status, line: formatStatusLine(status), previousTurnBackfill };
}
