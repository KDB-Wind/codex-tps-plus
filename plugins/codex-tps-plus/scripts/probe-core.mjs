import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROBE_SCHEMA_VERSION = 1;
export const PROBE_VERSION = "0.1.1";

const OBSERVATION_FILE_PATTERN = /^\d+-\d+-[A-Za-z0-9_-]+-[0-9a-f]{10}\.json$/;

const USAGE_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  ["cache_write_input_tokens", "cacheWriteInputTokens"],
  ["output_tokens", "outputTokens"],
  ["reasoning_output_tokens", "reasoningOutputTokens"],
  ["total_tokens", "totalTokens"],
];

const INTERESTING_PAYLOAD_TYPES = new Set([
  "task_started",
  "task_complete",
  "token_count",
  "turn_context",
  "context_compacted",
  "compaction_started",
  "compaction_completed",
  "turn_aborted",
  "turn_interrupted",
  "response.completed",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function stableId(value) {
  if (value === undefined || value === null || value === "") return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function presentPath(value) {
  return typeof value === "string" && value.length > 0 ? { present: true } : { present: false };
}

function textShape(value) {
  if (value === undefined || value === null) return { present: false };
  const text = String(value);
  return { present: true, length: text.length };
}

function keyList(value) {
  return isObject(value) ? Object.keys(value).sort() : [];
}

function normalizeUsage(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!isObject(candidate)) return null;
  const output = {};
  for (const [source, target] of USAGE_FIELDS) {
    const number = finiteNumber(candidate[source]);
    if (number !== null) output[target] = number;
  }
  return Object.keys(output).length ? output : null;
}

function summarizeToolInput(value) {
  if (!isObject(value)) return { type: Array.isArray(value) ? "array" : typeof value };
  const result = { keys: Object.keys(value).sort() };
  if (typeof value.command === "string") result.command = textShape(value.command);
  return result;
}

export function summarizeHookInput(input) {
  const value = isObject(input) ? input : {};
  const result = {
    inputKeys: Object.keys(value).sort(),
    hookEventName: value.hook_event_name ?? null,
    sessionId: stableId(value.session_id),
    turnId: stableId(value.turn_id),
    agentId: stableId(value.agent_id),
    cwd: presentPath(value.cwd),
    transcriptPath: presentPath(value.transcript_path),
    model: typeof value.model === "string" ? value.model : null,
    permissionMode: value.permission_mode ?? null,
  };

  for (const key of ["source", "trigger", "reason", "agent_type", "tool_name", "tool_use_id"]) {
    if (value[key] !== undefined) {
      result[key === "agent_type" ? "agentType" : key === "tool_name" ? "toolName" : key] =
        key === "tool_use_id" ? stableId(value[key]) : value[key];
    }
  }
  if (value.stop_hook_active !== undefined) result.stopHookActive = Boolean(value.stop_hook_active);
  if (value.prompt !== undefined) result.prompt = textShape(value.prompt);
  if (value.last_assistant_message !== undefined) {
    result.lastAssistantMessage = textShape(value.last_assistant_message);
  }
  if (value.tool_input !== undefined) result.toolInput = summarizeToolInput(value.tool_input);
  if (value.tool_response !== undefined) {
    result.toolResponse = { type: Array.isArray(value.tool_response) ? "array" : typeof value.tool_response };
  }
  return result;
}

function ensureTurn(turns, rawTurnId) {
  const key = rawTurnId || "__unattributed__";
  if (!turns.has(key)) {
    turns.set(key, {
      turnId: stableId(rawTurnId),
      tokenCountEvents: 0,
      taskCompleteEvents: 0,
      tokenCounts: [],
      taskCompleteLines: [],
    });
  }
  return turns.get(key);
}

function summarizeEvent(record, line, activeTurnId) {
  if (!isObject(record)) return null;
  const payload = isObject(record.payload) ? record.payload : null;
  const payloadType = payload?.type ?? null;
  const envelopeType = typeof record.type === "string" ? record.type : null;
  const base = {
    line,
    envelopeType,
    payloadType,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
    attributedTurnId: stableId(activeTurnId),
  };

  if (payloadType === "token_count") {
    return {
      ...base,
      lastTokenUsage: normalizeUsage(payload.info?.last_token_usage),
      totalTokenUsage: normalizeUsage(payload.info?.total_token_usage),
      infoKeys: keyList(payload.info),
    };
  }
  if (payloadType === "task_started") {
    return {
      ...base,
      turnId: stableId(payload.turn_id),
      startedAt: finiteNumber(payload.started_at),
      modelContextWindow: finiteNumber(payload.model_context_window),
    };
  }
  if (payloadType === "task_complete") {
    return {
      ...base,
      turnId: stableId(payload.turn_id),
      startedAt: finiteNumber(payload.started_at),
      completedAt: finiteNumber(payload.completed_at),
      durationMs: finiteNumber(payload.duration_ms),
      timeToFirstTokenMs: finiteNumber(payload.time_to_first_token_ms),
    };
  }
  if (payloadType === "turn_context") {
    return {
      ...base,
      turnId: stableId(payload.turn_id),
      model: typeof payload.model === "string" ? payload.model : null,
      contextKeys: keyList(payload),
    };
  }
  if (envelopeType === "response_item") {
    return {
      ...base,
      itemType: payloadType,
      role: typeof payload.role === "string" ? payload.role : null,
      phase: typeof payload.phase === "string" ? payload.phase : null,
      status: typeof payload.status === "string" ? payload.status : null,
    };
  }
  if (payloadType && (INTERESTING_PAYLOAD_TYPES.has(payloadType) || /compact|interrupt|abort/i.test(payloadType))) {
    return { ...base, payloadKeys: keyList(payload) };
  }
  return null;
}

function sanitizeSessionMeta(payload) {
  if (!isObject(payload)) return null;
  return {
    cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : null,
    historyMode: typeof payload.history_mode === "string" ? payload.history_mode : null,
    source: typeof payload.source === "string" ? payload.source : null,
    threadSource: typeof payload.thread_source === "string" ? payload.thread_source : null,
    modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : null,
    payloadKeys: keyList(payload),
  };
}

export function summarizeTranscript(transcriptPath, options = {}) {
  const startedAt = Date.now();
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : 500;
  const maxTurns = Number.isInteger(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : 200;
  const empty = {
    available: false,
    reason: transcriptPath ? "unreadable" : "not_provided",
    format: null,
    sizeBytes: null,
    lineCount: 0,
    recordCount: 0,
    parseErrorCount: 0,
    parseErrorLines: [],
    selectedEvents: [],
    selectedEventCount: 0,
    truncatedEventCount: 0,
    turns: [],
    currentTurn: null,
    sessionMeta: null,
    readStartedAtMs: startedAt,
    readFinishedAtMs: Date.now(),
  };
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return empty;

  let stat;
  let text;
  try {
    stat = fs.statSync(transcriptPath);
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return { ...empty, readFinishedAtMs: Date.now() };
  }

  const lines = text.split(/\r?\n/);
  const turns = new Map();
  let activeTurnId = null;
  let sessionMeta = null;
  let historyMode = null;
  let recordCount = 0;
  let parseErrorCount = 0;
  const parseErrorLines = [];
  const selectedEvents = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const line = index + 1;
    let record;
    try {
      record = JSON.parse(raw);
      recordCount += 1;
    } catch {
      parseErrorCount += 1;
      if (parseErrorLines.length < 20) parseErrorLines.push(line);
      continue;
    }
    const payload = isObject(record?.payload) ? record.payload : null;
    if (record?.type === "session_meta") {
      sessionMeta = sanitizeSessionMeta(payload);
      historyMode = sessionMeta?.historyMode ?? historyMode;
    }
    if (payload?.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      ensureTurn(turns, activeTurnId);
    }
    const event = summarizeEvent(record, line, activeTurnId);
    if (!event) continue;
    if (event.payloadType === "token_count") {
      const turn = ensureTurn(turns, activeTurnId);
      turn.tokenCountEvents += 1;
      if (event.lastTokenUsage) turn.tokenCounts.push(event.lastTokenUsage);
      else turn.tokenCounts.push(null);
    }
    if (event.payloadType === "task_complete") {
      const rawTurnId = payload?.turn_id || activeTurnId;
      const turn = ensureTurn(turns, rawTurnId);
      turn.taskCompleteEvents += 1;
      turn.taskCompleteLines.push(line);
      if (rawTurnId === activeTurnId) activeTurnId = null;
    }
    selectedEvents.push(event);
  }

  const selected = selectedEvents.slice(-maxEvents);
  const allTurns = [...turns.values()];
  const turnList = allTurns.slice(-maxTurns).map((turn) => ({
    ...turn,
    tokenCounts: turn.tokenCounts.slice(-20),
  }));
  const currentRawTurnId = options.currentTurnId;
  const currentTurn = currentRawTurnId
    ? {
        turnId: stableId(currentRawTurnId),
        ...(turns.get(currentRawTurnId)
          ? {
              tokenCountEvents: turns.get(currentRawTurnId).tokenCountEvents,
              taskCompleteEvents: turns.get(currentRawTurnId).taskCompleteEvents,
              taskCompleteLines: turns.get(currentRawTurnId).taskCompleteLines,
            }
          : { tokenCountEvents: 0, taskCompleteEvents: 0, taskCompleteLines: [] }),
      }
    : null;

  return {
    available: true,
    format: historyMode || "unknown",
    historyMode,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    endedWithNewline: /(?:\r\n|\n)$/.test(text),
    lineCount: lines.length - (lines.at(-1) === "" ? 1 : 0),
    recordCount,
    parseErrorCount,
    parseErrorLines,
    selectedEvents: selected,
    selectedEventCount: selected.length,
    truncatedEventCount: Math.max(0, selectedEvents.length - selected.length),
    turns: turnList,
    truncatedTurnCount: Math.max(0, allTurns.length - turnList.length),
    currentTurn,
    sessionMeta,
    tokenCountAttribution: "nearest-preceding-active-task",
    readStartedAtMs: startedAt,
    readFinishedAtMs: Date.now(),
  };
}

export function captureHookObservation({ eventName, input, includeTranscript = true }) {
  const transcriptPath = isObject(input) ? input.transcript_path : null;
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    probeVersion: PROBE_VERSION,
    capturedAt: new Date().toISOString(),
    pid: process.pid,
    eventName,
    input: summarizeHookInput(input),
    transcript: includeTranscript
      ? summarizeTranscript(transcriptPath, {
          currentTurnId: isObject(input) ? input.turn_id : null,
        })
      : {
          available: false,
          reason: "event_not_selected",
        },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export function pruneObservationFiles(directory, options = {}) {
  const maxFiles = Number.isSafeInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 500;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : 64 * 1024 * 1024;
  let files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && OBSERVATION_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file);
      return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  while (files.length > maxFiles || totalBytes > maxBytes) {
    const oldest = files.shift();
    if (!oldest) break;
    totalBytes -= oldest.size;
    try {
      fs.unlinkSync(oldest.file);
    } catch {
      // Concurrent collectors can race while pruning the same old file.
    }
  }
  return { files: files.length, bytes: totalBytes };
}

export function writeObservation(directory, observation, options = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const event = String(observation.eventName || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  const suffix = crypto.randomBytes(5).toString("hex");
  const base = `${Date.now()}-${process.pid}-${event}-${suffix}.json`;
  const finalPath = path.join(directory, base);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(observation, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
  pruneObservationFiles(directory, options);
  return finalPath;
}
