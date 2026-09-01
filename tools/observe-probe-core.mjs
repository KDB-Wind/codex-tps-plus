import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CAPTURE_FORMAT_VERSION = 1;
export const PROBE_VERSION = "phase-six-probe-0.1.0";
export const TESTED_SCHEMA_VERSIONS = Object.freeze(["v2"]);
// This is an observation guard, not a product-version compatibility promise. Add a
// daemon here only after its app-server notification/response shape has been tested.
export const TESTED_DAEMON_VERSIONS = Object.freeze([
  "codex-cli 0.149.1",
  "codex-tui 0.149.1",
]);

export function normalizeDaemonVersion(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const stableMatch = text.match(/\b(codex-(?:tui|cli))\/([A-Za-z0-9._+-]+)/);
  const stable = stableMatch ? `${stableMatch[1]} ${stableMatch[2]}` : text;
  return stable.replace(/[^A-Za-z0-9 ._+-]/g, "_").slice(0, 120);
}

export const OUTGOING_METHOD_WHITELIST = Object.freeze([
  "initialize",
  "initialized",
  "thread/list",
  "thread/loaded/list",
  "thread/resume",
  "thread/unsubscribe",
]);

const OUTGOING_METHODS = new Set(OUTGOING_METHOD_WHITELIST);

export const NOTIFICATION_CLASSES = Object.freeze({
  required: Object.freeze([
    "turn/started",
    "item/started",
    "item/completed",
    "turn/completed",
  ]),
  metricRequired: Object.freeze([
    "item/agentMessage/delta",
    "thread/tokenUsage/updated",
  ]),
  optional: Object.freeze([
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
  ]),
  lifecycle: Object.freeze([
    "thread/started",
    "thread/closed",
    "thread/archived",
  ]),
});

const REQUIRED_METHODS = new Set(NOTIFICATION_CLASSES.required);
const METRIC_REQUIRED_METHODS = new Set(NOTIFICATION_CLASSES.metricRequired);
const OPTIONAL_METHODS = new Set(NOTIFICATION_CLASSES.optional);
const LIFECYCLE_METHODS = new Set(NOTIFICATION_CLASSES.lifecycle);

const DEFAULT_MAX_EVENTS = 5_000;
const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_ITEMS_PER_TURN = 500;
const DEFAULT_MAX_USAGE_UPDATES = 2_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2;
const MAX_SAFE_METHOD_LENGTH = 120;
const MAX_SAFE_ERROR_ENTRIES = 40;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function safeMethodName(value) {
  if (typeof value !== "string" || value.length === 0) return "<invalid>";
  const normalized = value.replace(/[^A-Za-z0-9_./:-]/g, "_");
  return normalized.slice(0, MAX_SAFE_METHOD_LENGTH) || "<invalid>";
}

export function hashIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function classifyNotification(method) {
  if (REQUIRED_METHODS.has(method)) return "required";
  if (METRIC_REQUIRED_METHODS.has(method)) return "metric-required";
  if (OPTIONAL_METHODS.has(method)) return "optional";
  if (LIFECYCLE_METHODS.has(method)) return "lifecycle";
  return "unknown";
}

export function classifyServerRequest(method) {
  if (typeof method !== "string") return "unknown-server-request";
  if (/approval|requestApproval/i.test(method)) return "approval";
  if (/requestUserInput|elicitation|userInput/i.test(method)) return "user-input";
  if (/tool|call/i.test(method)) return "tool-call";
  if (/auth.*refresh|refresh.*auth/i.test(method)) return "auth-refresh";
  if (method === "currentTime/read") return "current-time";
  return "other-server-request";
}

export function isOutgoingMethodAllowed(method) {
  return typeof method === "string" && OUTGOING_METHODS.has(method);
}

export function measureText(text) {
  if (typeof text !== "string") return null;
  return {
    unicodeCodePoints: [...text].length,
    utf8Bytes: Buffer.byteLength(text, "utf8"),
  };
}

function addLengths(left, right) {
  return {
    unicodeCodePoints: (left?.unicodeCodePoints || 0) + (right?.unicodeCodePoints || 0),
    utf8Bytes: (left?.utf8Bytes || 0) + (right?.utf8Bytes || 0),
  };
}

function lengthGap(left, right) {
  if (!left || !right) return null;
  return {
    unicodeCodePoints: Math.abs(left.unicodeCodePoints - right.unicodeCodePoints),
    utf8Bytes: Math.abs(left.utf8Bytes - right.utf8Bytes),
  };
}

function safeIso(timestampMs) {
  const value = finiteNumber(timestampMs);
  const date = value === null ? new Date(0) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function nowFrom(clock) {
  const value = finiteNumber(clock?.());
  return value === null ? Date.now() : value;
}

function safeTokenBreakdown(value) {
  if (!isObject(value)) return null;
  const fields = [
    ["inputTokens", ["inputTokens", "input_tokens"]],
    ["cachedInputTokens", ["cachedInputTokens", "cached_input_tokens"]],
    ["cacheWriteInputTokens", ["cacheWriteInputTokens", "cache_write_input_tokens"]],
    ["outputTokens", ["outputTokens", "output_tokens"]],
    ["reasoningOutputTokens", ["reasoningOutputTokens", "reasoning_output_tokens"]],
    ["totalTokens", ["totalTokens", "total_tokens"]],
  ];
  const result = {};
  for (const [target, sources] of fields) {
    let valueFound = null;
    for (const source of sources) {
      const candidate = nonNegativeNumber(value[source]);
      if (candidate !== null) {
        valueFound = candidate;
        break;
      }
    }
    if (valueFound === null && target === "cacheWriteInputTokens" && !Object.keys(value).some((key) =>
      sources.includes(key)
    )) {
      valueFound = 0;
    }
    if (valueFound === null) return null;
    result[target] = valueFound;
  }
  return result;
}

function safeTokenUsage(value) {
  if (!isObject(value)) return null;
  const last = safeTokenBreakdown(value.last);
  const total = safeTokenBreakdown(value.total);
  return last && total ? { last, total } : null;
}

function tokenFingerprint(usage) {
  return JSON.stringify(usage);
}

function incrementBoundedCount(target, key, maxKeys = 500) {
  if (Object.prototype.hasOwnProperty.call(target, key) || Object.keys(target).length < maxKeys) {
    target[key] = (target[key] || 0) + 1;
  }
}

function sumLengths(target, length) {
  target.unicodeCodePoints += length.unicodeCodePoints;
  target.utf8Bytes += length.utf8Bytes;
}

function createTextAccumulator() {
  return {
    digest: crypto.createHash("sha256"),
    length: { unicodeCodePoints: 0, utf8Bytes: 0 },
    deltaCount: 0,
    finalized: false,
    finalDigest: null,
    finalLength: null,
    hasDelta: false,
    outOfOrder: false,
  };
}

function appendText(accumulator, text) {
  const length = measureText(text);
  if (!accumulator || !length) return null;
  if (accumulator.finalized) {
    accumulator.outOfOrder = true;
    return length;
  }
  accumulator.digest.update(Buffer.from(text, "utf8"));
  sumLengths(accumulator.length, length);
  accumulator.deltaCount += 1;
  accumulator.hasDelta = true;
  return length;
}

function finalizeText(accumulator, text) {
  const length = measureText(text);
  if (!accumulator || !length) return { matched: null, gapSize: null, length };
  if (accumulator.finalized) {
    accumulator.outOfOrder = true;
    return { matched: false, gapSize: lengthGap(accumulator.finalLength, length), length };
  }
  const finalDigest = crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  accumulator.finalized = true;
  accumulator.finalDigest = finalDigest;
  accumulator.finalLength = length;
  if (!accumulator.hasDelta || accumulator.outOfOrder) {
    return { matched: false, gapSize: lengthGap(accumulator.length, length), length };
  }
  const observedDigest = accumulator.digest.digest("hex");
  const matched = observedDigest === finalDigest &&
    accumulator.length.unicodeCodePoints === length.unicodeCodePoints &&
    accumulator.length.utf8Bytes === length.utf8Bytes;
  return {
    matched,
    gapSize: lengthGap(accumulator.length, length),
    length,
  };
}

function extractThreadId(params) {
  if (!isObject(params)) return null;
  if (typeof params.threadId === "string" && params.threadId) return params.threadId;
  if (typeof params.thread_id === "string" && params.thread_id) return params.thread_id;
  if (typeof params.thread?.id === "string" && params.thread.id) return params.thread.id;
  if (typeof params.turn?.threadId === "string" && params.turn.threadId) return params.turn.threadId;
  return null;
}

function extractTurnId(params) {
  if (!isObject(params)) return null;
  if (typeof params.turnId === "string" && params.turnId) return params.turnId;
  if (typeof params.turn_id === "string" && params.turn_id) return params.turn_id;
  if (typeof params.turn?.id === "string" && params.turn.id) return params.turn.id;
  return null;
}

function extractItem(params) {
  if (!isObject(params) || !isObject(params.item)) return null;
  return params.item;
}

function extractItemId(params) {
  if (!isObject(params)) return null;
  if (typeof params.itemId === "string" && params.itemId) return params.itemId;
  if (typeof params.item_id === "string" && params.item_id) return params.item_id;
  if (typeof params.item?.id === "string" && params.item.id) return params.item.id;
  return null;
}

function extractTurnStatus(params) {
  if (!isObject(params)) return null;
  if (typeof params.status === "string") return params.status;
  if (typeof params.turn?.status === "string") return params.turn.status;
  return null;
}

function normalizeThreadIds(result, method) {
  if (!isObject(result) || !Array.isArray(result.data)) return null;
  const ids = [];
  for (const item of result.data) {
    const id = method === "thread/loaded/list"
      ? item
      : (typeof item === "string" ? item : item?.id);
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeErrorCode(error) {
  if (!isObject(error)) return "rpc_error";
  const code = finiteNumber(error.code);
  if (code !== null) return `rpc_${String(Math.trunc(code))}`;
  return "rpc_error";
}

export class ProtocolViolationError extends Error {
  constructor(code, method) {
    super(code);
    this.name = "ProtocolViolationError";
    this.code = code;
    this.method = safeMethodName(method);
  }
}

export class ProbeCaptureWriter {
  constructor(directory, options = {}) {
    if (typeof directory !== "string" || !directory) throw new TypeError("capture_directory_required");
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.eventsPath = path.join(this.directory, "events.ndjson");
    this.summaryPath = path.join(this.directory, "probe-summary.json");
    this.maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    this.eventsAttempted = 0;
    this.eventsPersisted = 0;
    this.eventsDropped = 0;
    this.eventBytes = 0;
    this.closed = false;
  }

  write(event) {
    if (this.closed) return false;
    this.eventsAttempted += 1;
    if (this.maxFiles < 2 || this.eventsAttempted > this.maxEvents) {
      this.eventsDropped += 1;
      return false;
    }
    const safeEvent = {
      formatVersion: event?.formatVersion,
      sequence: event?.sequence,
      capturedAt: event?.capturedAt,
      method: event?.method,
      direction: event?.direction,
      classification: event?.classification,
      threadId: event?.threadId ?? null,
      turnId: event?.turnId ?? null,
      itemId: event?.itemId ?? null,
      length: event?.length ?? null,
      matched: event?.matched ?? null,
      gapSize: event?.gapSize ?? null,
    };
    const line = `${JSON.stringify(safeEvent)}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (this.eventBytes + size > this.maxBytes) {
      this.eventsDropped += 1;
      return false;
    }
    fs.appendFileSync(this.eventsPath, line, { encoding: "utf8", mode: 0o600 });
    this.eventsPersisted += 1;
    this.eventBytes += size;
    return true;
  }

  stats() {
    return {
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      eventsAttempted: this.eventsAttempted,
      eventsPersisted: this.eventsPersisted,
      eventsDropped: this.eventsDropped,
      eventBytes: this.eventBytes,
    };
  }

  trimEvents(allowedBytes) {
    if (!fs.existsSync(this.eventsPath)) return;
    const original = fs.readFileSync(this.eventsPath);
    if (original.length <= allowedBytes) return;
    const cut = Math.max(0, Math.min(original.length, allowedBytes));
    const newline = original.lastIndexOf(0x0a, Math.max(0, cut - 1));
    const retained = newline >= 0 ? original.subarray(0, newline + 1) : Buffer.alloc(0);
    if (retained.length === 0) {
      fs.unlinkSync(this.eventsPath);
    } else {
      fs.writeFileSync(this.eventsPath, retained, { mode: 0o600 });
    }
    const retainedCount = retained.length === 0
      ? 0
      : retained.toString("utf8").split("\n").filter(Boolean).length;
    this.eventsDropped += Math.max(0, this.eventsPersisted - retainedCount);
    this.eventsPersisted = retainedCount;
    this.eventBytes = retained.length;
  }

  static compactSummary(summary) {
    return {
      formatVersion: summary.formatVersion,
      probeVersion: summary.probeVersion,
      runId: summary.runId,
      schemaVersion: summary.schemaVersion,
      schemaVersionSource: summary.schemaVersionSource,
      schemaVersionObservedInInitialize: summary.schemaVersionObservedInInitialize,
      captureOnly: summary.captureOnly,
      captureSuggested: summary.captureSuggested,
      captureSuggestionReason: summary.captureSuggestionReason,
      daemonVersion: summary.daemonVersion,
      daemonVersionSource: summary.daemonVersionSource,
      finishedAt: summary.finishedAt,
      summaryTruncated: true,
      capacity: summary.capacity,
    };
  }

  finalize(summary) {
    if (this.closed) return { summaryPath: this.summaryPath, summary };
    this.closed = true;
    let output = {
      ...summary,
      capacity: {
        ...(summary.capacity || {}),
        ...this.stats(),
      },
    };
    let encoded = `${JSON.stringify(output, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maxBytes) {
      output = ProbeCaptureWriter.compactSummary(output);
      encoded = `${JSON.stringify(output)}\n`;
    }
    const summaryBytes = Buffer.byteLength(encoded, "utf8");
    this.trimEvents(Math.max(0, this.maxBytes - summaryBytes));
    output.capacity = {
      ...(output.capacity || {}),
      ...this.stats(),
      totalBytesBeforeSummary: this.eventBytes + summaryBytes,
      fileCount: fs.existsSync(this.eventsPath) ? 2 : 1,
    };
    encoded = `${JSON.stringify(output, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maxBytes) {
      output = ProbeCaptureWriter.compactSummary(output);
      encoded = `${JSON.stringify(output)}\n`;
      this.trimEvents(Math.max(0, this.maxBytes - Buffer.byteLength(encoded, "utf8")));
      output.capacity = {
        ...(output.capacity || {}),
        ...this.stats(),
        totalBytesBeforeSummary: this.eventBytes + Buffer.byteLength(encoded, "utf8"),
        fileCount: fs.existsSync(this.eventsPath) ? 2 : 1,
      };
      encoded = `${JSON.stringify(output)}\n`;
    }
    const tempPath = `${this.summaryPath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tempPath, encoded, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tempPath, this.summaryPath);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The rename normally removes the temporary path.
      }
    }
    return { summaryPath: this.summaryPath, summary: output };
  }
}

export function prepareRunDirectory(outputPath) {
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new TypeError("output_directory_required");
  }
  const requested = path.resolve(outputPath);
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  const entries = fs.readdirSync(requested);
  if (entries.length === 0) return requested;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = path.join(
      requested,
      `run-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`
    );
    try {
      fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("run_directory_allocation_failed");
}

export function assertIndependentOutputDirectory(outputPath, env = process.env) {
  const target = path.resolve(outputPath);
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
    ? env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
  const defaultV05Data = path.join(
    codexHome,
    "plugins",
    "data",
    "codex-tps-plus-personal"
  );
  const forbiddenBases = [env.TPS_PLUS_DATA_DIR, env.PLUGIN_DATA, defaultV05Data]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => path.resolve(value));
  for (const base of forbiddenBases) {
    const relative = path.relative(base, target);
    if (relative === "" || (relative && !relative.startsWith(`..${path.sep}`) && relative !== "..")) {
      throw new Error("output_directory_overlaps_v05_data");
    }
  }
  return target;
}

export class ProbeState {
  constructor(options = {}) {
    this.clock = typeof options.clock === "function" ? options.clock : Date.now;
    this.runId = typeof options.runId === "string" && options.runId
      ? options.runId
      : `run-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
    this.schemaVersion = typeof options.schemaVersion === "string" && options.schemaVersion
      ? options.schemaVersion
      : "unknown";
    this.testedSchemaVersions = new Set(options.testedSchemaVersions || TESTED_SCHEMA_VERSIONS);
    this.schemaVersionSource = typeof options.schemaVersionSource === "string" && options.schemaVersionSource
      ? options.schemaVersionSource
      : "caller_supplied";
    this.schemaVersionObservedInInitialize = false;
    this.knownDaemonVersions = new Set(options.knownDaemonVersions || TESTED_DAEMON_VERSIONS);
    this.daemonVersion = null;
    this.daemonVersionSource = null;
    this.captureOnly = true;
    this.captureSuggested = true;
    this.captureSuggestionReason = null;
    this.eventSink = typeof options.eventSink === "function" ? options.eventSink : () => {};
    this.onE1Failure = typeof options.onE1Failure === "function" ? options.onE1Failure : () => {};
    this.maxTurns = positiveInteger(options.maxTurns, DEFAULT_MAX_TURNS);
    this.maxItemsPerTurn = positiveInteger(options.maxItemsPerTurn, DEFAULT_MAX_ITEMS_PER_TURN);
    this.maxUsageUpdates = positiveInteger(options.maxUsageUpdates, DEFAULT_MAX_USAGE_UPDATES);
    this.cleanupTimeoutMs = Math.max(0, finiteNumber(options.cleanupTimeoutMs) ?? 30_000);
    this.usageTerminalVerified = options.usageTerminalVerified === true;
    this.selectedThreadId = typeof options.threadId === "string" && options.threadId
      ? options.threadId
      : null;
    this.initialThreadId = this.selectedThreadId;
    this.sequence = 0;
    this.connected = false;
    this.connectionCount = 0;
    this.reconnectCount = 0;
    this.currentConnectionOpenedAtMs = null;
    this.lastDisconnect = null;
    this.discovery = {
      methods: [],
      candidates: [],
      candidateCount: 0,
      selectedBy: this.selectedThreadId ? "argument" : null,
      requiresManualThreadId: false,
    };
    this.handshake = {
      initialize: { sent: false, ok: false, roundTripMs: null },
      initialized: { sent: false },
    };
    this.resume = {
      sent: false,
      ok: false,
      requestedThreadId: this.selectedThreadId,
      returnedThreadId: null,
      excludeTurns: true,
      replayedTurnCount: 0,
    };
    this.unsubscribe = { sent: false, ok: false, status: null };
    this.sentMethodCounts = {};
    this.responseMethodCounts = {};
    this.notificationCounts = Object.create(null);
    this.notificationClassCounts = {
      required: 0,
      "metric-required": 0,
      optional: 0,
      lifecycle: 0,
      unknown: 0,
    };
    this.unknownNotifications = 0;
    this.filteredNotifications = 0;
    this.requiredIssues = [];
    this.metricIssues = [];
    this.fieldMismatches = [];
    this.errors = [];
    this.serverRequests = [];
    this.e1Failures = [];
    this.protocolInvariants = {
      threadIdChanged: false,
      forkObserved: false,
      replayObserved: false,
      extraTurnCount: 0,
      observedTurnCount: 0,
      unattributedNotificationCount: 0,
    };
    this.turns = new Map();
    this.turnOrder = [];
    this.invalidatedTurnIds = new Set();
    this.windowInvalidations = [];
    this.cleanupTimers = new Set();
    this.lifecycleCounts = Object.create(null);
    this.orphanUsageUpdates = 0;
    this.intermediateUsageUpdatesAfterDisconnect = 0;
    this.memoryCleanupCount = 0;
    this.updateCaptureSuggestion();
    if (options.daemonVersion) this.setDaemonVersion(options.daemonVersion, "constructor_option");
  }

  nowMs() {
    return nowFrom(this.clock);
  }

  setDaemonVersion(value, source = this.daemonVersionSource || "unknown") {
    const normalized = normalizeDaemonVersion(value);
    if (!normalized) return;
    this.daemonVersion = normalized;
    this.daemonVersionSource = source;
    this.updateCaptureSuggestion();
  }

  setSchemaVersion(value, source = this.schemaVersionSource) {
    if (typeof value !== "string" || !value) return;
    this.schemaVersion = value;
    this.schemaVersionSource = source;
    this.updateCaptureSuggestion();
  }

  updateCaptureSuggestion() {
    const schemaUntested = !this.testedSchemaVersions.has(this.schemaVersion);
    const daemonUnknown = !this.knownDaemonVersions.has(this.daemonVersion);
    this.captureOnly = schemaUntested || daemonUnknown;
    this.captureSuggested = this.captureOnly;
    this.captureSuggestionReason = schemaUntested
      ? "schema_untested"
      : daemonUnknown ? "daemon_version_unknown" : null;
  }

  setSelectedThreadId(threadId, selectedBy = "argument") {
    if (typeof threadId !== "string" || !threadId) return false;
    if (this.selectedThreadId && this.selectedThreadId !== threadId) {
      this.protocolInvariants.threadIdChanged = true;
      this.e1Fail("thread_id_changed");
      return false;
    }
    this.selectedThreadId = threadId;
    this.resume.requestedThreadId = threadId;
    this.discovery.selectedBy = selectedBy;
    return true;
  }

  openConnection() {
    this.connected = true;
    this.connectionCount += 1;
    if (this.connectionCount > 1) this.reconnectCount += 1;
    this.currentConnectionOpenedAtMs = this.nowMs();
  }

  scheduleCleanup(window) {
    if (!window || window.memoryCleaned || this.cleanupTimeoutMs < 0) return;
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      window.items.clear();
      window.items = new Map();
      window.usageUpdates.length = 0;
      window.usageFingerprints.clear();
      window.previousTotal = null;
      window.latestUsage = null;
      window.memoryCleaned = true;
      this.memoryCleanupCount += 1;
    }, this.cleanupTimeoutMs);
    timer.unref?.();
    this.cleanupTimers.add(timer);
  }

  invalidateOpenWindows(reason) {
    const safeReason = safeMethodName(reason || "connection_closed");
    const timestamp = this.nowMs();
    for (const window of this.turns.values()) {
      if (window.status !== "inProgress" || window.invalidated) continue;
      window.invalidated = true;
      window.invalidReason = safeReason;
      window.status = "unavailable";
      window.availabilityReason = safeReason;
      this.invalidatedTurnIds.add(window.rawTurnId);
      const missingRequired = [...REQUIRED_METHODS].filter((method) => !window.seenMethods.has(method));
      window.final = {
        turnId: hashIdentifier(window.rawTurnId),
        threadId: hashIdentifier(window.rawThreadId),
        status: "unavailable",
        startedAtMs: window.startedAtMs,
        completedAtMs: null,
        durationMs: null,
        required: {
          available: false,
          missing: missingRequired,
        },
        metrics: {
          live: {
            available: false,
            labels: {
              characterRate: "LIVE≈ unicode_code_points/s",
              byteRate: "LIVE≈ utf8_bytes/s",
            },
            reason: safeReason,
            characterCountMode: "unicode_code_points",
            byteEncoding: "utf8",
          },
          ttft: { available: false, label: "TTFT(client)", reason: safeReason },
          usage: {
            available: false,
            reason: "no_terminal_usage_snapshot",
            intermediateUpdates: window.usageObservedCount,
          },
        },
        partialUsage: null,
        coverage: {
          matched: window.coverageMatched,
          mismatched: window.coverageMismatched,
          unavailable: window.coverageUnavailable,
        },
        intermediateUsageUpdateCount: window.usageObservedCount,
        usageDuplicateEvents: window.usageDuplicateEvents,
        usageTotalMonotonic: window.usageMonotonic,
        usageReasoningSubset: window.usageReasoningSubset,
      };
      this.windowInvalidations.push({
        turnId: hashIdentifier(window.rawTurnId),
        reason: safeReason,
        at: safeIso(timestamp),
        disconnectedAt: safeIso(timestamp),
        reconnected: false,
        cleanupTimeoutMs: this.cleanupTimeoutMs,
      });
      this.scheduleCleanup(window);
    }
    this.lastDisconnect = {
      at: safeIso(timestamp),
      reason: safeReason,
      reconnected: false,
      cleanupTimeoutMs: this.cleanupTimeoutMs,
    };
    this.connected = false;
  }

  connectionClosed(reason = "connection_closed") {
    if (!this.connected && this.lastDisconnect) return;
    this.invalidateOpenWindows(reason);
  }

  markReconnected() {
    if (this.lastDisconnect) this.lastDisconnect.reconnected = true;
    for (const invalidation of this.windowInvalidations) {
      if (!invalidation.reconnected) invalidation.reconnected = true;
    }
  }

  recordError(code, field = null) {
    if (this.errors.length >= MAX_SAFE_ERROR_ENTRIES) return;
    this.errors.push({
      code: safeMethodName(code),
      field: typeof field === "string" ? safeMethodName(field) : null,
      at: safeIso(this.nowMs()),
    });
  }

  recordFieldMismatch(method, field) {
    if (this.fieldMismatches.length >= MAX_SAFE_ERROR_ENTRIES) return;
    this.fieldMismatches.push({
      method: safeMethodName(method),
      field: safeMethodName(field),
    });
  }

  e1Fail(code, details = {}) {
    const safeCode = safeMethodName(code);
    if (!this.e1Failures.some((failure) => failure.code === safeCode)) {
      const failure = { code: safeCode };
      if (typeof details.method === "string") failure.method = safeMethodName(details.method);
      if (typeof details.kind === "string") failure.kind = safeMethodName(details.kind);
      this.e1Failures.push(failure);
    }
    try {
      this.onE1Failure(safeCode);
    } catch {
      this.recordError("e1_failure_callback_failed");
    }
  }

  recordEvent({
    method,
    direction = "incoming",
    classification = "unknown",
    threadId = null,
    turnId = null,
    itemId = null,
    length = null,
    matched = null,
    gapSize = null,
  }) {
    const event = {
      formatVersion: CAPTURE_FORMAT_VERSION,
      sequence: ++this.sequence,
      capturedAt: safeIso(this.nowMs()),
      method: safeMethodName(method),
      direction: direction === "outgoing" ? "outgoing" : "incoming",
      classification: safeMethodName(classification),
      threadId: hashIdentifier(threadId),
      turnId: hashIdentifier(turnId),
      itemId: hashIdentifier(itemId),
      length: length
        ? {
            unicodeCodePoints: nonNegativeNumber(length.unicodeCodePoints),
            utf8Bytes: nonNegativeNumber(length.utf8Bytes),
          }
        : null,
      matched: matched === true ? true : matched === false ? false : null,
      gapSize: gapSize
        ? {
            unicodeCodePoints: nonNegativeNumber(gapSize.unicodeCodePoints),
            utf8Bytes: nonNegativeNumber(gapSize.utf8Bytes),
          }
        : null,
    };
    try {
      this.eventSink(event);
    } catch {
      this.recordError("event_sink_failed");
    }
    return event;
  }

  recordOutgoing(method, params = null) {
    if (!isOutgoingMethodAllowed(method)) {
      this.e1Fail("forbidden_outgoing_method", { method });
      throw new ProtocolViolationError("forbidden_outgoing_method", method);
    }
    if (method === "thread/resume" && (!isObject(params) || typeof params.threadId !== "string" || !params.threadId)) {
      this.e1Fail("resume_thread_id_missing", { method });
      throw new ProtocolViolationError("resume_thread_id_missing", method);
    }
    if (method === "thread/resume" && params.excludeTurns !== true) {
      this.e1Fail("resume_exclude_turns_false", { method });
      throw new ProtocolViolationError("resume_exclude_turns_false", method);
    }
    this.sentMethodCounts[method] = (this.sentMethodCounts[method] || 0) + 1;
    if (method === "initialize") this.handshake.initialize.sent = true;
    if (method === "initialized") this.handshake.initialized.sent = true;
    if (method === "thread/resume") {
      this.resume.sent = true;
      this.resume.excludeTurns = params?.excludeTurns === true;
    }
    if (method === "thread/unsubscribe") this.unsubscribe.sent = true;
    this.recordEvent({
      method,
      direction: "outgoing",
      classification: "protocol",
      threadId: params?.threadId,
    });
  }

  recordResponse(method, result, error = null) {
    this.responseMethodCounts[method] = (this.responseMethodCounts[method] || 0) + 1;
    const ok = !error;
    if (method === "initialize") {
      this.handshake.initialize.ok = ok;
      if (isObject(result)) {
        this.setDaemonVersion(result.userAgent, "initialize_response");
        if (typeof result.schemaVersion === "string" && result.schemaVersion) {
          this.schemaVersionObservedInInitialize = true;
          this.setSchemaVersion(result.schemaVersion, "initialize_response");
        }
      }
    }
    if (method === "thread/loaded/list" || method === "thread/list") {
      const candidates = normalizeThreadIds(result, method);
      if (!candidates) {
        this.recordFieldMismatch(method, "data");
      } else {
        this.discovery.methods.push(method);
        this.discovery.candidates = candidates;
        this.discovery.candidateCount = candidates.length;
      }
    }
    if (method === "thread/resume") {
      this.resume.ok = ok;
      const returned = result?.thread?.id;
      if (typeof returned === "string" && returned) {
        this.resume.returnedThreadId = returned;
        if (this.selectedThreadId && returned !== this.selectedThreadId) {
          this.protocolInvariants.threadIdChanged = true;
          this.e1Fail("thread_id_changed");
        }
      } else if (ok) {
        this.recordFieldMismatch(method, "thread.id");
      }
      const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
      this.resume.replayedTurnCount = turns.length;
      if (turns.length > 0) {
        this.protocolInvariants.replayObserved = true;
        this.e1Fail("resume_replayed_turns");
      }
    }
    if (method === "thread/unsubscribe") {
      this.unsubscribe.ok = ok;
      const status = typeof result?.status === "string" ? result.status : null;
      this.unsubscribe.status = status ? safeMethodName(status) : null;
      this.unsubscribe.ok = ok && ["unsubscribed", "notSubscribed", "notLoaded"].includes(status);
      if (ok && status === null) this.recordFieldMismatch(method, "status");
    }
    if (error) this.recordError(normalizeErrorCode(error));
    return { ok, errorCode: error ? normalizeErrorCode(error) : null };
  }

  recordDiscoverySelection(candidates, explicitThreadId = null) {
    const unique = [...new Set((candidates || []).filter((id) => typeof id === "string" && id))];
    this.discovery.candidates = unique;
    this.discovery.candidateCount = unique.length;
    if (explicitThreadId) {
      this.setSelectedThreadId(explicitThreadId, "argument");
      return { selected: explicitThreadId, requiresManualThreadId: false };
    }
    if (unique.length === 1) {
      this.setSelectedThreadId(unique[0], "single-candidate");
      return { selected: unique[0], requiresManualThreadId: false };
    }
    this.discovery.requiresManualThreadId = true;
    if (unique.length > 1) this.recordError("multiple_active_threads_requires_thread_id");
    return { selected: null, requiresManualThreadId: unique.length > 1 };
  }

  handleServerRequest(message) {
    const method = typeof message?.method === "string" ? message.method : "<invalid>";
    const kind = classifyServerRequest(method);
    const entry = {
      method: safeMethodName(method),
      kind,
      requestIdPresent: message?.id !== undefined,
      decision: kind === "current-time"
        ? "fail_closed_current_time_request_not_exempted"
        : "fail_closed_no_response",
    };
    if (this.serverRequests.length < MAX_SAFE_ERROR_ENTRIES) this.serverRequests.push(entry);
    this.e1Fail("server_request_routed", { method, kind });
    this.recordEvent({ method, classification: "e1-fail-server-request" });
    return { failed: true, kind };
  }

  isSelectedThread(threadId) {
    if (!this.selectedThreadId || !threadId) return true;
    return threadId === this.selectedThreadId;
  }

  noteRequiredIssue(method, field = null) {
    const issue = { method: safeMethodName(method), field: field ? safeMethodName(field) : null };
    if (!this.requiredIssues.some((item) => item.method === issue.method && item.field === issue.field)) {
      this.requiredIssues.push(issue);
    }
  }

  noteMetricIssue(metric, reason) {
    const issue = { metric: safeMethodName(metric), reason: safeMethodName(reason) };
    if (!this.metricIssues.some((item) => item.metric === issue.metric && item.reason === issue.reason)) {
      this.metricIssues.push(issue);
    }
  }

  createWindow(threadId, turnId) {
    if (this.turns.size >= this.maxTurns) {
      this.noteRequiredIssue("turn/started", "maxTurns");
      return null;
    }
    const window = {
      rawThreadId: threadId,
      rawTurnId: turnId,
      startedAtMs: this.nowMs(),
      completedAtMs: null,
      status: "inProgress",
      invalidated: false,
      invalidReason: null,
      availabilityReason: null,
      seenMethods: new Set(["turn/started"]),
      items: new Map(),
      agentDeltaSeen: false,
      agentDeltaLength: { unicodeCodePoints: 0, utf8Bytes: 0 },
      reasoningTextSeen: false,
      reasoningSummarySeen: false,
      reasoningTextLength: { unicodeCodePoints: 0, utf8Bytes: 0 },
      reasoningSummaryLength: { unicodeCodePoints: 0, utf8Bytes: 0 },
      firstDeltaAtMs: null,
      ttftMs: null,
      coverageMatched: 0,
      coverageMismatched: 0,
      coverageUnavailable: 0,
      agentItemCount: 0,
      finalizedAgentItemCount: 0,
      usageUpdates: [],
      usageFingerprints: new Set(),
      usageObservedCount: 0,
      usageUpdateOverflow: false,
      usageDuplicateEvents: 0,
      usageMonotonic: true,
      usageReasoningSubset: true,
      previousTotal: null,
      latestUsage: null,
      memoryCleaned: false,
      final: null,
    };
    this.turns.set(turnId, window);
    this.turnOrder.push(turnId);
    if (this.turnOrder.length > this.maxTurns) this.turnOrder.shift();
    return window;
  }

  activeWindow(threadId, turnId) {
    if (!threadId || !turnId || !this.isSelectedThread(threadId)) return null;
    if (this.invalidatedTurnIds.has(turnId)) return null;
    const window = this.turns.get(turnId);
    return window?.status === "inProgress" && !window.invalidated ? window : null;
  }

  itemAccumulator(window, itemId, kind = "agent") {
    if (!window || !itemId) return null;
    const key = `${kind}:${itemId}`;
    if (!window.items.has(key)) {
      if (window.items.size >= this.maxItemsPerTurn) {
        this.noteMetricIssue("item/agentMessage/delta", "maxItemsPerTurn");
        return null;
      }
      window.items.set(key, {
        kind,
        rawItemId: itemId,
        accumulator: createTextAccumulator(),
        itemType: null,
        started: false,
        completed: false,
      });
    }
    return window.items.get(key);
  }

  markFirstVisibleDelta(window) {
    if (!window || window.firstDeltaAtMs !== null) return;
    const atMs = this.nowMs();
    window.firstDeltaAtMs = atMs;
    window.ttftMs = Math.max(0, atMs - window.startedAtMs);
  }

  handleNotification(message) {
    const method = typeof message?.method === "string" ? message.method : null;
    if (!method) {
      this.recordError("notification_method_missing");
      return { handled: false };
    }
    const params = isObject(message.params) ? message.params : {};
    const classification = classifyNotification(method);
    incrementBoundedCount(this.notificationCounts, safeMethodName(method));
    this.notificationClassCounts[classification] = (this.notificationClassCounts[classification] || 0) + 1;
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const itemId = extractItemId(params);
    if (classification === "unknown") this.unknownNotifications += 1;
    if (/fork/i.test(method)) {
      this.protocolInvariants.forkObserved = true;
      this.e1Fail("fork_observed", { method });
    }
    if (this.selectedThreadId && threadId && threadId !== this.selectedThreadId) {
      this.filteredNotifications += 1;
      this.recordEvent({ method, classification, threadId, turnId, itemId });
      return { handled: true, filtered: true };
    }
    if (this.captureOnly) {
      this.recordEvent({ method, classification, threadId, turnId, itemId });
      return { handled: true, captureOnly: true };
    }

    if (LIFECYCLE_METHODS.has(method)) {
      incrementBoundedCount(this.lifecycleCounts, method);
      this.recordEvent({ method, classification, threadId, turnId, itemId });
      return { handled: true };
    }
    if (method === "turn/started") return this.handleTurnStarted(params);
    if (method === "turn/completed") return this.handleTurnCompleted(params);
    if (method === "item/started") return this.handleItemStarted(params);
    if (method === "item/completed") return this.handleItemCompleted(params);
    if (method === "item/agentMessage/delta") return this.handleAgentDelta(params);
    if (OPTIONAL_METHODS.has(method)) return this.handleReasoningNotification(method, params);
    if (method === "thread/tokenUsage/updated") return this.handleUsage(params);
    this.recordEvent({ method, classification, threadId, turnId, itemId });
    return { handled: true, unknown: true };
  }

  handleTurnStarted(params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    if (!threadId || !turnId) {
      this.recordFieldMismatch("turn/started", !threadId ? "threadId" : "turn.id");
      this.noteRequiredIssue("turn/started", !threadId ? "threadId" : "turn.id");
      this.recordEvent({ method: "turn/started", classification: "required", threadId, turnId });
      return { handled: true, available: false };
    }
    if (this.invalidatedTurnIds.has(turnId)) {
      this.recordEvent({ method: "turn/started", classification: "required", threadId, turnId });
      return { handled: true, ignoredAfterInvalidation: true };
    }
    const existing = this.turns.get(turnId);
    if (existing) {
      this.protocolInvariants.replayObserved = true;
      this.protocolInvariants.extraTurnCount += 1;
      this.e1Fail("duplicate_turn_id");
      this.recordEvent({ method: "turn/started", classification: "required", threadId, turnId });
      return { handled: true, duplicate: true, ignored: true };
    }
    const window = this.createWindow(threadId, turnId);
    if (window) this.protocolInvariants.observedTurnCount += 1;
    this.recordEvent({ method: "turn/started", classification: "required", threadId, turnId });
    return { handled: true, available: Boolean(window) };
  }

  handleItemStarted(params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const itemId = extractItemId(params);
    const item = extractItem(params);
    const window = this.activeWindow(threadId, turnId);
    if (!itemId || !item) {
      this.recordFieldMismatch("item/started", !itemId ? "item.id" : "item");
      this.noteRequiredIssue("item/started", !itemId ? "item.id" : "item");
      this.recordEvent({ method: "item/started", classification: "required", threadId, turnId, itemId });
      return { handled: true, available: false };
    }
    if (!window) {
      this.protocolInvariants.unattributedNotificationCount += 1;
      this.noteRequiredIssue("item/started", "turn_window");
      this.recordEvent({ method: "item/started", classification: "required", threadId, turnId, itemId });
      return { handled: true, available: false };
    }
    window.seenMethods.add("item/started");
    const itemType = typeof item.type === "string" ? item.type : null;
    const entry = this.itemAccumulator(window, itemId, itemType === "agentMessage" ? "agent" : "other");
    if (entry) {
      entry.started = true;
      entry.itemType = itemType;
      if (itemType === "agentMessage") window.agentItemCount += 1;
    }
    this.recordEvent({ method: "item/started", classification: "required", threadId, turnId, itemId });
    return { handled: true, available: Boolean(entry) };
  }

  handleAgentDelta(params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const itemId = extractItemId(params);
    const delta = params?.delta;
    if (typeof delta !== "string") {
      this.recordFieldMismatch("item/agentMessage/delta", "delta");
      this.noteMetricIssue("live", "delta_type_mismatch");
      this.recordEvent({ method: "item/agentMessage/delta", classification: "metric-required", threadId, turnId, itemId });
      return { handled: true, available: false };
    }
    const length = measureText(delta);
    const window = this.activeWindow(threadId, turnId);
    if (!window || !itemId) {
      this.noteMetricIssue("live", "delta_without_open_turn");
      this.recordEvent({ method: "item/agentMessage/delta", classification: "metric-required", threadId, turnId, itemId, length });
      return { handled: true, available: false };
    }
    const entry = this.itemAccumulator(window, itemId, "agent");
    if (!entry) {
      this.recordEvent({ method: "item/agentMessage/delta", classification: "metric-required", threadId, turnId, itemId, length });
      return { handled: true, available: false };
    }
    const appended = appendText(entry.accumulator, delta);
    if (!appended) {
      this.noteMetricIssue("live", "delta_not_counted");
      this.recordEvent({ method: "item/agentMessage/delta", classification: "metric-required", threadId, turnId, itemId, length });
      return { handled: true, available: false };
    }
    if (!entry.started) entry.itemType = "agentMessage";
    window.agentDeltaSeen = true;
    sumLengths(window.agentDeltaLength, appended);
    this.markFirstVisibleDelta(window);
    this.recordEvent({ method: "item/agentMessage/delta", classification: "metric-required", threadId, turnId, itemId, length });
    return { handled: true, available: true };
  }

  handleReasoningNotification(method, params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const itemId = extractItemId(params);
    const delta = params?.delta;
    const window = this.activeWindow(threadId, turnId);
    if (method === "item/reasoning/summaryPartAdded") {
      if (window) window.seenMethods.add(method);
      this.recordEvent({ method, classification: "optional", threadId, turnId, itemId });
      return { handled: true, optional: true };
    }
    if (typeof delta !== "string") {
      this.recordFieldMismatch(method, "delta");
      this.recordEvent({ method, classification: "optional", threadId, turnId, itemId });
      return { handled: true, optional: true, available: false };
    }
    const length = measureText(delta);
    if (window) {
      window.seenMethods.add(method);
      this.markFirstVisibleDelta(window);
      if (method === "item/reasoning/textDelta") {
        window.reasoningTextSeen = true;
        sumLengths(window.reasoningTextLength, length);
      } else {
        window.reasoningSummarySeen = true;
        sumLengths(window.reasoningSummaryLength, length);
      }
    }
    this.recordEvent({ method, classification: "optional", threadId, turnId, itemId, length });
    return { handled: true, optional: true, available: true };
  }

  handleItemCompleted(params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const itemId = extractItemId(params);
    const item = extractItem(params);
    const window = this.activeWindow(threadId, turnId);
    if (!itemId || !item) {
      this.recordFieldMismatch("item/completed", !itemId ? "item.id" : "item");
      this.noteRequiredIssue("item/completed", !itemId ? "item.id" : "item");
      this.recordEvent({ method: "item/completed", classification: "required", threadId, turnId, itemId });
      return { handled: true, available: false };
    }
    if (!window) {
      this.protocolInvariants.unattributedNotificationCount += 1;
      this.noteRequiredIssue("item/completed", "turn_window");
      this.recordEvent({ method: "item/completed", classification: "required", threadId, turnId, itemId });
      return { handled: true, available: false };
    }
    window.seenMethods.add("item/completed");
    const itemType = typeof item.type === "string" ? item.type : null;
    const entry = this.itemAccumulator(window, itemId, itemType === "agentMessage" ? "agent" : "other");
    let result = { matched: null, gapSize: null, length: null };
    if (itemType === "agentMessage") {
      window.agentItemCount += entry?.started ? 0 : 1;
      if (typeof item.text !== "string") {
        this.recordFieldMismatch("item/completed", "item.text");
        window.coverageUnavailable += 1;
        this.noteMetricIssue("live", "completed_text_missing");
      } else if (entry) {
        result = finalizeText(entry.accumulator, item.text);
        entry.completed = true;
        entry.itemType = itemType;
        window.finalizedAgentItemCount += 1;
        if (result.matched === true) window.coverageMatched += 1;
        else if (result.matched === false) window.coverageMismatched += 1;
        else window.coverageUnavailable += 1;
      }
    }
    this.recordEvent({
      method: "item/completed",
      classification: "required",
      threadId,
      turnId,
      itemId,
      length: result.length,
      matched: result.matched,
      gapSize: result.gapSize,
    });
    return { handled: true, ...result };
  }

  handleUsage(params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const usage = safeTokenUsage(params?.tokenUsage ?? params?.token_usage);
    if (!threadId || !turnId || !usage) {
      this.recordFieldMismatch("thread/tokenUsage/updated", !turnId ? "turnId" : "tokenUsage");
      this.noteMetricIssue("turn-scoped-usage", "usage_type_mismatch");
      this.recordEvent({ method: "thread/tokenUsage/updated", classification: "metric-required", threadId, turnId });
      return { handled: true, available: false };
    }
    const window = this.activeWindow(threadId, turnId);
    if (!window) {
      this.orphanUsageUpdates += 1;
      if (!this.connected) this.intermediateUsageUpdatesAfterDisconnect += 1;
      this.recordEvent({ method: "thread/tokenUsage/updated", classification: "metric-required", threadId, turnId });
      return { handled: true, available: false, orphan: true };
    }
    window.seenMethods.add("thread/tokenUsage/updated");
    const fingerprint = tokenFingerprint(usage);
    window.usageObservedCount += 1;
    if (window.usageFingerprints.has(fingerprint)) {
      window.usageDuplicateEvents += 1;
    } else {
      if (window.usageFingerprints.size < this.maxUsageUpdates) {
        window.usageFingerprints.add(fingerprint);
      } else {
        window.usageUpdateOverflow = true;
      }
      const previous = window.previousTotal;
      if (previous) {
        for (const key of Object.keys(usage.total)) {
          if (usage.total[key] < previous[key]) window.usageMonotonic = false;
        }
      }
      window.previousTotal = usage.total;
      if (
        usage.last.reasoningOutputTokens > usage.last.outputTokens ||
        usage.total.reasoningOutputTokens > usage.total.outputTokens
      ) {
        window.usageReasoningSubset = false;
      }
      if (window.usageUpdates.length < this.maxUsageUpdates) window.usageUpdates.push(usage);
      else window.usageUpdateOverflow = true;
      window.latestUsage = usage;
    }
    this.recordEvent({ method: "thread/tokenUsage/updated", classification: "metric-required", threadId, turnId });
    return { handled: true, available: true };
  }

  finalizeWindow(window, status) {
    if (!window || window.status !== "inProgress") return null;
    window.completedAtMs = this.nowMs();
    window.status = status;
    for (const method of REQUIRED_METHODS) {
      if (!window.seenMethods.has(method)) this.noteRequiredIssue(method, "missing");
    }
    for (const entry of window.items.values()) {
      if (entry.kind === "agent" && entry.accumulator.hasDelta && !entry.accumulator.finalized) {
        window.coverageUnavailable += 1;
      }
    }
    const requiredMissing = [...REQUIRED_METHODS].filter((method) => !window.seenMethods.has(method));
    const durationMs = window.completedAtMs - window.startedAtMs;
    const normalCompleted = status === "completed";
    const abnormal = status === "interrupted" || status === "failed";
    const reasoningLength = window.reasoningTextSeen
      ? window.reasoningTextLength
      : window.reasoningSummaryLength;
    const coverageMatched = window.agentDeltaSeen &&
      window.coverageMismatched === 0 &&
      window.coverageUnavailable === 0 &&
      window.agentItemCount > 0 &&
      window.finalizedAgentItemCount >= window.agentItemCount;
    const liveAvailable = normalCompleted &&
      !this.captureOnly &&
      durationMs > 0 &&
      window.agentDeltaSeen &&
      coverageMatched &&
      requiredMissing.length === 0;
    const ttftAvailable = normalCompleted && !this.captureOnly && window.ttftMs !== null;
    let partialUsage = null;
    if (!this.captureOnly && abnormal && this.usageTerminalVerified && window.latestUsage) {
      partialUsage = {
        available: true,
        turnStatus: status,
        source: "thread/tokenUsage/updated-terminal-snapshot",
        last: window.latestUsage.last,
        total: window.latestUsage.total,
      };
    }
    const usageAvailable = !this.captureOnly &&
      window.usageObservedCount > 0 &&
      (!abnormal || partialUsage !== null);
    if (abnormal || window.invalidated) {
      window.invalidated = true;
      window.invalidReason = status;
      this.invalidatedTurnIds.add(window.rawTurnId);
    }
    if (abnormal) {
      window.availabilityReason = "abnormal_turn";
      this.noteMetricIssue("live", `${status}_turn`);
      this.noteMetricIssue("ttft", `${status}_turn`);
    }
    const usage = this.captureOnly
      ? { available: false, reason: this.captureSuggestionReason || "capture_only" }
      : usageAvailable
        ? {
            available: true,
            displayEligible: false,
            reason: "e4_not_verified",
            source: "thread/tokenUsage/updated",
            observedUpdates: window.usageObservedCount,
            duplicateEvents: window.usageDuplicateEvents,
            updateOverflow: window.usageUpdateOverflow,
            totalMonotonic: window.usageMonotonic,
            reasoningSubset: window.usageReasoningSubset,
            last: window.latestUsage.last,
            total: window.latestUsage.total,
          }
        : {
            available: false,
            reason: abnormal ? "partial_usage_not_verified" : "metric_required_missing",
          };
    const live = liveAvailable
      ? {
          available: true,
          labels: {
            characterRate: "LIVE≈ unicode_code_points/s",
            byteRate: "LIVE≈ utf8_bytes/s",
          },
          source: "app-server-client-observed",
          estimate: true,
          coverage: {
            agentMessage: "matched",
            reasoning: window.reasoningTextSeen || window.reasoningSummarySeen
              ? "observed"
              : "optional_unavailable",
          },
          characterCount: window.agentDeltaLength.unicodeCodePoints + reasoningLength.unicodeCodePoints,
          byteCount: window.agentDeltaLength.utf8Bytes + reasoningLength.utf8Bytes,
          characterRate: (window.agentDeltaLength.unicodeCodePoints + reasoningLength.unicodeCodePoints) /
            (durationMs / 1000),
          byteRate: (window.agentDeltaLength.utf8Bytes + reasoningLength.utf8Bytes) /
            (durationMs / 1000),
          characterCountMode: "unicode_code_points",
          byteEncoding: "utf8",
          durationMs,
        }
      : {
          available: false,
          labels: {
            characterRate: "LIVE≈ unicode_code_points/s",
            byteRate: "LIVE≈ utf8_bytes/s",
          },
          reason: this.captureOnly
            ? this.captureSuggestionReason || "capture_only"
            : abnormal ? "abnormal_turn" : "coverage_or_required_event_unavailable",
          coverage: {
            agentMessage: window.coverageMismatched > 0
              ? "mismatched"
              : window.agentDeltaSeen ? "unavailable" : "missing",
            reasoning: window.reasoningTextSeen || window.reasoningSummarySeen
              ? "observed"
              : "optional_unavailable",
          },
          characterCountMode: "unicode_code_points",
          byteEncoding: "utf8",
        };
    const ttft = ttftAvailable
      ? {
          available: true,
          label: "TTFT(client)",
          valueMs: window.ttftMs,
          source: "turn/started-to-first-visible-delta",
          scope: "turn",
          notPerRequestAverage: true,
        }
      : {
          available: false,
          label: "TTFT(client)",
          reason: this.captureOnly
            ? this.captureSuggestionReason || "capture_only"
            : abnormal ? "abnormal_turn" : "first_delta_or_turn_missing",
        };
    if (!normalCompleted && !partialUsage) usage.unavailable = true;
    window.final = {
      turnId: hashIdentifier(window.rawTurnId),
      threadId: hashIdentifier(window.rawThreadId),
      status,
      startedAtMs: window.startedAtMs,
      completedAtMs: window.completedAtMs,
      durationMs: normalCompleted && durationMs > 0 ? durationMs : null,
      required: {
        available: requiredMissing.length === 0,
        missing: requiredMissing,
      },
      metrics: { live, ttft, usage },
      partialUsage,
      coverage: {
        matched: window.coverageMatched,
        mismatched: window.coverageMismatched,
        unavailable: window.coverageUnavailable,
      },
      intermediateUsageUpdateCount: window.usageObservedCount,
      usageDuplicateEvents: window.usageDuplicateEvents,
      usageTotalMonotonic: window.usageMonotonic,
      usageReasoningSubset: window.usageReasoningSubset,
    };
    this.scheduleCleanup(window);
    return window.final;
  }

  handleTurnCompleted(params) {
    const threadId = extractThreadId(params);
    const turnId = extractTurnId(params);
    const status = extractTurnStatus(params);
    if (!threadId || !turnId || !status) {
      this.recordFieldMismatch("turn/completed", !threadId ? "threadId" : !turnId ? "turn.id" : "turn.status");
      this.noteRequiredIssue("turn/completed", "field_type_mismatch");
      this.recordEvent({ method: "turn/completed", classification: "required", threadId, turnId });
      return { handled: true, available: false };
    }
    const window = this.turns.get(turnId);
    if (!window || window.invalidated || this.invalidatedTurnIds.has(turnId)) {
      this.protocolInvariants.unattributedNotificationCount += 1;
      this.noteRequiredIssue("turn/completed", "turn_window");
      this.recordEvent({ method: "turn/completed", classification: "required", threadId, turnId });
      return { handled: true, available: false };
    }
    if (!["completed", "interrupted", "failed"].includes(status)) {
      this.recordFieldMismatch("turn/completed", "turn.status");
      this.noteRequiredIssue("turn/completed", "terminal_status");
      this.recordEvent({ method: "turn/completed", classification: "required", threadId, turnId });
      return { handled: true, available: false };
    }
    window.seenMethods.add("turn/completed");
    const final = this.finalizeWindow(window, status);
    this.recordEvent({ method: "turn/completed", classification: "required", threadId, turnId });
    return { handled: true, available: Boolean(final), final };
  }

  setUsageTerminalVerified(value) {
    this.usageTerminalVerified = value === true;
  }

  summary(finishedAtMs = this.nowMs()) {
    const turnSummaries = this.turnOrder
      .map((turnId) => this.turns.get(turnId)?.final)
      .filter(Boolean)
      .slice(-this.maxTurns);
    const openTurnCount = [...this.turns.values()].filter((window) => window.status === "inProgress").length;
    return {
      formatVersion: CAPTURE_FORMAT_VERSION,
      probeVersion: PROBE_VERSION,
      runId: this.runId,
      schemaVersion: this.schemaVersion,
      schemaVersionSource: this.schemaVersionSource,
      schemaVersionObservedInInitialize: this.schemaVersionObservedInInitialize,
      captureOnly: this.captureOnly,
      captureSuggested: this.captureSuggested,
      captureSuggestionReason: this.captureSuggestionReason,
      testedSchemaVersions: [...this.testedSchemaVersions],
      knownDaemonVersions: [...this.knownDaemonVersions],
      testedDaemonVersions: [...this.knownDaemonVersions],
      startedAt: safeIso(this.startedAtMs),
      finishedAt: safeIso(finishedAtMs),
      daemonVersion: this.daemonVersion,
      daemonVersionSource: this.daemonVersionSource,
      transport: this.transportSummary || null,
      handshake: this.handshake,
      discovery: {
        methods: this.discovery.methods.slice(-5),
        candidateCount: this.discovery.candidateCount,
        selectedThreadId: hashIdentifier(this.selectedThreadId),
        selectedBy: this.discovery.selectedBy,
        requiresManualThreadId: this.discovery.requiresManualThreadId,
      },
      resume: {
        ...this.resume,
        requestedThreadId: hashIdentifier(this.resume.requestedThreadId),
        returnedThreadId: hashIdentifier(this.resume.returnedThreadId),
      },
      unsubscribe: this.unsubscribe,
      protocol: {
        outgoingWhitelist: OUTGOING_METHOD_WHITELIST,
        sentMethodCounts: this.sentMethodCounts,
        responseMethodCounts: this.responseMethodCounts,
        forbiddenAttemptCount: this.e1Failures.filter((failure) => failure.code === "forbidden_outgoing_method").length,
      },
      notifications: {
        counts: this.notificationCounts,
        classCounts: this.notificationClassCounts,
        unknownCount: this.unknownNotifications,
        filteredCount: this.filteredNotifications,
        lifecycleCounts: this.lifecycleCounts,
      },
      required: {
        methods: NOTIFICATION_CLASSES.required,
        issues: this.requiredIssues,
      },
      metricRequired: {
        methods: NOTIFICATION_CLASSES.metricRequired,
        issues: this.metricIssues,
      },
      optional: {
        methods: NOTIFICATION_CLASSES.optional,
        missingIsNotE1Failure: true,
      },
      serverRequests: this.serverRequests,
      e1: {
        status: this.e1Failures.length ? "fail" : "pending",
        failures: this.e1Failures,
        realExperimentRequired: true,
      },
      protocolInvariants: {
        ...this.protocolInvariants,
        threadIdStable: !this.protocolInvariants.threadIdChanged,
        noForkObserved: !this.protocolInvariants.forkObserved,
        noReplayObserved: !this.protocolInvariants.replayObserved,
      },
      connection: {
        connected: this.connected,
        connectionCount: this.connectionCount,
        reconnectCount: this.reconnectCount,
        openTurnCount,
        disconnectedAt: this.lastDisconnect?.at || null,
        windowInvalidationReason: this.windowInvalidations.at(-1)?.reason || null,
        reconnected: Boolean(this.lastDisconnect?.reconnected),
        cleanupTimeoutMs: this.cleanupTimeoutMs,
        windowInvalidations: this.windowInvalidations.slice(-this.maxTurns),
        intermediateUsageUpdatesAfterDisconnect: this.intermediateUsageUpdatesAfterDisconnect,
      },
      units: {
        characterCountMode: "unicode_code_points",
        byteEncoding: "utf8",
        characterRateUnit: "unicode_code_points_per_second",
        byteRateUnit: "utf8_bytes_per_second",
        notTokenTps: true,
      },
      turns: turnSummaries,
      errors: this.errors,
      fieldMismatches: this.fieldMismatches,
      orphanUsageUpdates: this.orphanUsageUpdates,
      e2: {
        status: "pending",
        realExperimentRequired: true,
      },
      capacity: {
        inMemoryMaxTurns: this.maxTurns,
        inMemoryMaxItemsPerTurn: this.maxItemsPerTurn,
        inMemoryMaxUsageUpdates: this.maxUsageUpdates,
        memoryCleanupCount: this.memoryCleanupCount,
      },
    };
  }
}

export function configureStateForRun(state, options = {}) {
  state.startedAtMs = state.nowMs();
  state.transportSummary = options.transportSummary || null;
  if (Object.prototype.hasOwnProperty.call(options, "usageTerminalVerified")) {
    state.setUsageTerminalVerified(options.usageTerminalVerified);
  }
  return state;
}
