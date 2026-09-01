import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOTIFICATION_CLASSES,
  OUTGOING_METHOD_WHITELIST,
  ProbeCaptureWriter,
  ProbeState,
  ProtocolViolationError,
  assertIndependentOutputDirectory,
  classifyNotification,
  configureStateForRun,
  measureText,
  normalizeDaemonVersion,
  TESTED_DAEMON_VERSIONS,
  prepareRunDirectory,
} from "../../../tools/observe-probe-core.mjs";
import {
  analyzePerformanceSamples,
  assessProtocolInvariants,
  compareE2BackfilledTiming,
  compareE2Duration,
  compareE2StaticFields,
  computeE2Reference,
} from "../../../tools/observe-probe-e2.mjs";
import { parseProbeArgs, runProbe } from "../../../tools/observe-probe.mjs";
import { JsonRpcClient, JsonRpcTransport, parseEndpoint } from "../../../tools/observe-probe-transport.mjs";
import { extractStopMetric } from "../scripts/status-core.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const e2FixturePath = path.join(
  repoRoot,
  "plugins",
  "codex-tps-plus",
  "test",
  "fixtures",
  "phase-six-e2-session.jsonl"
);

function tokenUsage(outputTokens, reasoningOutputTokens, totalOutputTokens = outputTokens) {
  const breakdown = (output, reasoning, total) => ({
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: total,
  });
  return {
    last: breakdown(outputTokens, reasoningOutputTokens, 100 + outputTokens),
    total: breakdown(totalOutputTokens, reasoningOutputTokens, 100 + totalOutputTokens),
  };
}

function makeState(options = {}) {
  let now = Date.parse("2026-09-01T00:00:00.000Z");
  const events = [];
  const state = new ProbeState({
    schemaVersion: "v2",
    threadId: "thread-test",
    clock: () => now,
    eventSink: (event) => events.push(event),
    ...options,
  });
  configureStateForRun(state, {});
  state.openConnection();
  return {
    state,
    events,
    advance(ms) {
      now += ms;
    },
  };
}

function startTurn(state, turnId = "turn-test") {
  state.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-test", turn: { id: turnId, status: "inProgress" } },
  });
}

function completeAgentItem(state, turnId, itemId, text) {
  state.handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-test",
      turnId,
      item: { id: itemId, type: "agentMessage", text: "" },
    },
  });
  state.handleNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-test", turnId, itemId, delta: text },
  });
  state.handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-test",
      turnId,
      item: { id: itemId, type: "agentMessage", text },
    },
  });
}

function completeTurn(state, turnId = "turn-test", status = "completed") {
  state.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-test", turn: { id: turnId, status } },
  });
}

test("phase-six notification classes and protocol whitelist are explicit", () => {
  assert.deepEqual(OUTGOING_METHOD_WHITELIST, [
    "initialize",
    "initialized",
    "thread/list",
    "thread/loaded/list",
    "thread/resume",
    "thread/unsubscribe",
  ]);
  assert.deepEqual(NOTIFICATION_CLASSES.required, [
    "turn/started",
    "item/started",
    "item/completed",
    "turn/completed",
  ]);
  assert.equal(classifyNotification("item/agentMessage/delta"), "metric-required");
  assert.equal(classifyNotification("thread/tokenUsage/updated"), "metric-required");
  assert.equal(classifyNotification("item/reasoning/textDelta"), "optional");
  assert.equal(classifyNotification("thread/started"), "lifecycle");
  assert.equal(classifyNotification("future/newNotification"), "unknown");
});

test("outgoing protocol violation fails closed before a forbidden method can be sent", () => {
  const { state, events } = makeState();
  assert.throws(
    () => state.recordOutgoing("turn/start", { threadId: "thread-test" }),
    (error) => error instanceof ProtocolViolationError && error.code === "forbidden_outgoing_method"
  );
  assert.equal(state.e1Failures[0].code, "forbidden_outgoing_method");
  assert.equal(events.some((event) => event.method === "turn/start"), false);
});

test("resume protocol violation fails closed when excludeTurns is not true", () => {
  const { state, events } = makeState();
  assert.throws(
    () => state.recordOutgoing("thread/resume", { threadId: "thread-test", excludeTurns: false }),
    (error) => error instanceof ProtocolViolationError && error.code === "resume_exclude_turns_false"
  );
  assert.equal(state.resume.sent, false);
  assert.equal(events.length, 0);
});

test("unsubscribe accepts the observed notLoaded terminal status", () => {
  const { state } = makeState();
  state.recordResponse("thread/unsubscribe", { status: "notLoaded" });
  assert.equal(state.unsubscribe.status, "notLoaded");
  assert.equal(state.unsubscribe.ok, true);
});

test("completed Unicode output compares in memory and reports code points and UTF-8 bytes", () => {
  const { state, advance } = makeState();
  startTurn(state);
  advance(10);
  completeAgentItem(state, "turn-test", "item-test", "A😀中");
  advance(20);
  completeTurn(state);
  const turn = state.summary().turns[0];
  assert.deepEqual(measureText("A😀中"), { unicodeCodePoints: 3, utf8Bytes: 8 });
  assert.equal(turn.metrics.live.available, true);
  assert.equal(turn.metrics.live.characterCount, 3);
  assert.equal(turn.metrics.live.byteCount, 8);
  assert.equal(turn.metrics.live.characterCountMode, "unicode_code_points");
  assert.equal(turn.metrics.live.byteEncoding, "utf8");
  assert.equal(turn.metrics.live.labels.characterRate, "LIVE≈ unicode_code_points/s");
  assert.equal(turn.metrics.ttft.label, "TTFT(client)");
  assert.equal(turn.metrics.live.characterRate, 100);
  assert.equal(turn.metrics.live.byteRate, 800 / 3);
  assert.equal(turn.metrics.live.coverage.agentMessage, "matched");
  assert.equal(turn.metrics.ttft.notPerRequestAverage, true);
  assert.equal(state.e1Failures.length, 0);
});

test("TTFT(client) starts at the first visible reasoning or answer delta", () => {
  const { state, advance } = makeState();
  startTurn(state, "turn-reasoning-first");
  advance(7);
  state.handleNotification({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread-test",
      turnId: "turn-reasoning-first",
      itemId: "item-reasoning",
      delta: "thinking",
    },
  });
  advance(9);
  completeAgentItem(state, "turn-reasoning-first", "item-answer", "answer");
  advance(1);
  completeTurn(state, "turn-reasoning-first");
  const turn = state.summary().turns[0];
  assert.equal(turn.metrics.ttft.available, true);
  assert.equal(turn.metrics.ttft.valueMs, 7);
  assert.equal(turn.metrics.ttft.source, "turn/started-to-first-visible-delta");
});

test("optional reasoning notifications do not become an E1 failure", () => {
  const { state } = makeState();
  startTurn(state);
  completeAgentItem(state, "turn-test", "item-test", "answer");
  completeTurn(state);
  const summary = state.summary();
  assert.equal(summary.e1.status, "pending");
  assert.deepEqual(summary.e1.failures, []);
  assert.equal(summary.turns[0].metrics.live.coverage.reasoning, "optional_unavailable");
});

test("missing required and metric-required notifications close only their dependent metrics", () => {
  const { state, advance } = makeState();
  startTurn(state, "turn-missing-events");
  advance(5);
  state.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-test",
      turnId: "turn-missing-events",
      itemId: "item-missing-events",
      delta: "partial",
    },
  });
  advance(5);
  completeTurn(state, "turn-missing-events");
  const summary = state.summary();
  const turn = summary.turns[0];
  assert.equal(turn.required.available, false);
  assert.deepEqual(turn.required.missing.sort(), ["item/completed", "item/started"]);
  assert.equal(turn.metrics.live.available, false);
  assert.equal(turn.metrics.ttft.available, true);
  assert.equal(summary.e1.status, "pending");
  assert.deepEqual(summary.e1.failures, []);
});

test("distinct observed turns are counted without being mislabeled as observer-created turns", () => {
  const { state, advance } = makeState();
  startTurn(state, "turn-one");
  completeAgentItem(state, "turn-one", "item-one", "one");
  advance(1);
  completeTurn(state, "turn-one");
  startTurn(state, "turn-two");
  completeAgentItem(state, "turn-two", "item-two", "two");
  advance(1);
  completeTurn(state, "turn-two");
  const invariants = state.summary().protocolInvariants;
  assert.equal(invariants.observedTurnCount, 2);
  assert.equal(invariants.extraTurnCount, 0);
  assert.equal(invariants.noReplayObserved, true);
});

test("server-to-client approval request is recorded without replying and fails E1", () => {
  const { state, events } = makeState();
  const result = state.handleServerRequest({
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { command: "PRIVATE_APPROVAL_COMMAND" },
  });
  assert.equal(result.failed, true);
  assert.equal(state.serverRequests[0].kind, "approval");
  assert.equal(state.serverRequests[0].decision, "fail_closed_no_response");
  assert.equal(state.e1Failures[0].code, "server_request_routed");
  assert.equal(events.some((event) => event.method === "item/commandExecution/requestApproval"), true);
  assert.equal(JSON.stringify(events).includes("PRIVATE_APPROVAL_COMMAND"), false);
});

test("unknown schema is capture-only and still redacts delta content", () => {
  const events = [];
  const state = new ProbeState({
    schemaVersion: "v99",
    threadId: "thread-test",
    eventSink: (event) => events.push(event),
  });
  state.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-test",
      turnId: "turn-unknown-schema",
      itemId: "item-unknown-schema",
      delta: "UNKNOWN_SCHEMA_PRIVATE_DELTA",
    },
  });
  state.handleNotification({
    method: "future/newNotification",
    params: { secret: "unknown-field" },
  });
  const summary = state.summary();
  assert.equal(summary.captureOnly, true);
  assert.equal(summary.schemaVersion, "v99");
  assert.equal(summary.notifications.unknownCount, 1);
  assert.equal(summary.turns.length, 0);
  assert.equal(JSON.stringify(events).includes("UNKNOWN_SCHEMA_PRIVATE_DELTA"), false);
  assert.equal(JSON.stringify(summary).includes("UNKNOWN_SCHEMA_PRIVATE_DELTA"), false);
});

test("schema capture guidance records the initialize limitation and unknown daemon version", () => {
  const state = new ProbeState({ schemaVersion: "v2", schemaVersionSource: "cli_argument" });
  state.setDaemonVersion(TESTED_DAEMON_VERSIONS[0]);
  let summary = state.summary();
  assert.equal(summary.captureSuggested, false);
  assert.equal(summary.captureSuggestionReason, null);
  assert.equal(summary.schemaVersionObservedInInitialize, false);
  state.recordResponse("initialize", { userAgent: "codex-cli 9.99.0" });
  summary = state.summary();
  assert.equal(summary.daemonVersion, "codex-cli 9.99.0");
  assert.equal(summary.captureOnly, false);
  assert.equal(summary.captureSuggested, true);
  assert.equal(summary.captureSuggestionReason, "daemon_version_unknown");
  assert.equal(summary.schemaVersionSource, "cli_argument");
  const responseVersionState = new ProbeState({ schemaVersion: "v2", schemaVersionSource: "cli_argument" });
  responseVersionState.recordResponse("initialize", {
    userAgent: TESTED_DAEMON_VERSIONS[0],
    schemaVersion: "v99",
  });
  summary = responseVersionState.summary();
  assert.equal(summary.schemaVersion, "v99");
  assert.equal(summary.schemaVersionSource, "initialize_response");
  assert.equal(summary.schemaVersionObservedInInitialize, true);
  assert.equal(summary.captureOnly, true);
  assert.equal(summary.captureSuggested, true);
  assert.equal(summary.captureSuggestionReason, "schema_untested");
});

test("initialize user-agent normalization keeps the stable tested daemon label", () => {
  assert.equal(normalizeDaemonVersion("codex-tui/0.149.1 (Windows 10.0.26200; x86_64) Orca/1.4.193 (probe; 0.1.0)"), "codex-tui 0.149.1");
  const state = new ProbeState({ schemaVersion: "v2", schemaVersionSource: "cli_argument" });
  state.recordResponse("initialize", {
    userAgent: "codex-tui/0.149.1 (Windows 10.0.26200; x86_64) Orca/1.4.193 (probe; 0.1.0)",
  });
  const summary = state.summary();
  assert.equal(summary.daemonVersion, "codex-tui 0.149.1");
  assert.equal(summary.captureSuggested, false);
  assert.equal(summary.captureSuggestionReason, null);
});

test("disconnect invalidates an open window and reconnect cannot restore it", async () => {
  const { state, advance } = makeState({ cleanupTimeoutMs: 1 });
  startTurn(state, "turn-disconnect");
  state.handleNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-test",
      turnId: "turn-disconnect",
      tokenUsage: tokenUsage(8, 3),
    },
  });
  advance(5);
  state.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-test",
      turnId: "turn-disconnect",
      itemId: "item-disconnect",
      delta: "partial private text",
    },
  });
  state.connectionClosed("transport_closed");
  state.markReconnected();
  state.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-test",
      turn: { id: "turn-disconnect", status: "inProgress" },
    },
  });
  const summary = state.summary();
  const turn = summary.turns[0];
  assert.equal(turn.status, "unavailable");
  assert.equal(turn.metrics.live.available, false);
  assert.equal(turn.metrics.ttft.available, false);
  assert.equal(turn.metrics.usage.available, false);
  assert.equal(turn.partialUsage, null);
  assert.equal(summary.connection.windowInvalidationReason, "transport_closed");
  assert.equal(summary.connection.reconnected, true);
  assert.equal(summary.connection.intermediateUsageUpdatesAfterDisconnect, 0);
  assert.equal(summary.turns.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const window = state.turns.get("turn-disconnect");
  assert.equal(window.memoryCleaned, true);
  assert.equal(window.usageUpdates.length, 0);
  assert.equal(window.usageFingerprints.size, 0);
  assert.equal(window.latestUsage, null);
});

test("interrupted turns expose partialUsage only with explicit terminal usage evidence", () => {
  const { state } = makeState({ usageTerminalVerified: true });
  startTurn(state, "turn-interrupted");
  state.handleNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-test",
      turnId: "turn-interrupted",
      tokenUsage: tokenUsage(12, 4),
    },
  });
  completeTurn(state, "turn-interrupted", "interrupted");
  const turn = state.summary().turns[0];
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.metrics.live.available, false);
  assert.equal(turn.metrics.ttft.available, false);
  assert.equal(turn.metrics.usage.available, true);
  assert.equal(turn.partialUsage.turnStatus, "interrupted");
  assert.equal(turn.partialUsage.last.outputTokens, 12);
  assert.equal(turn.durationMs, null);
});

test("failed turns do not expose unverified usage as partialUsage", () => {
  const { state } = makeState();
  startTurn(state, "turn-failed");
  state.handleNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-test",
      turnId: "turn-failed",
      tokenUsage: tokenUsage(12, 4),
    },
  });
  completeTurn(state, "turn-failed", "failed");
  const turn = state.summary().turns[0];
  assert.equal(turn.metrics.usage.available, false);
  assert.equal(turn.metrics.usage.reason, "partial_usage_not_verified");
  assert.equal(turn.partialUsage, null);
});

test("capture writer bounds records, uses an atomic summary, and writes no content digest field", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-phase-six-writer-"));
  const directory = path.join(temp, "run");
  const writer = new ProbeCaptureWriter(directory, { maxEvents: 1, maxBytes: 2_048, maxFiles: 2 });
  writer.write({
    formatVersion: 1,
    sequence: 1,
    capturedAt: new Date().toISOString(),
    method: "item/agentMessage/delta",
    direction: "incoming",
    classification: "metric-required",
    threadId: "abc",
    turnId: "def",
    itemId: "ghi",
    length: { unicodeCodePoints: 4, utf8Bytes: 4 },
    matched: null,
    gapSize: null,
  });
  writer.write({ method: "future/second" });
  const result = writer.finalize({
    formatVersion: 1,
    probeVersion: "phase-six-probe-0.1.0",
    runId: "run-test",
    schemaVersion: "v2",
    captureOnly: false,
    finishedAt: new Date().toISOString(),
  });
  const names = fs.readdirSync(directory);
  assert.equal(names.includes("probe-summary.json"), true);
  assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  const contents = names
    .filter((name) => name.endsWith(".json") || name.endsWith(".ndjson"))
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("\n");
  assert.equal(contents.includes("deltaHash"), false);
  assert.equal(contents.includes("contentHash"), false);
  assert.equal(contents.includes("PRIVATE_APPROVAL_COMMAND"), false);
  assert.equal(result.summary.capacity.eventsPersisted, 1);
  assert.equal(result.summary.capacity.eventsDropped >= 1, true);
  assert.equal(
    names.reduce((total, name) => total + fs.statSync(path.join(directory, name)).size, 0) <= 2_048,
    true
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("E2 reference uses capturedAt as the duration anchor and stays independent", () => {
  const base = Date.parse("2026-09-01T01:00:00.000Z");
  const at = (offset) => new Date(base + offset).toISOString();
  const reference = computeE2Reference(e2FixturePath, "turn-e2", { nowMs: base + 6_000 });
  const boundary = computeE2Reference(e2FixturePath, "turn-boundary", { nowMs: base + 86_410_000 });
  const production = extractStopMetric(e2FixturePath, "turn-e2", { nowMs: base + 6_000 });
  const actual = {
    capturedAt: at(6_000),
    metric: {
      outputTokens: 15,
      reasoningTokens: 6,
      requestDurationMs: 2_000,
      estimatedOutputTokens: 15,
      estimatedRequestCount: 2,
      unestimatedRequestCount: 0,
      tokenCountEvents: 2,
      duplicateTokenCountEvents: 1,
      toolCallCount: 1,
      durationMs: 6_000,
    },
  };
  assert.equal(reference.available, true);
  assert.deepEqual(reference.staticFields, actual.metric && {
    outputTokens: 15,
    reasoningTokens: 6,
    requestDurationMs: 2_000,
    estimatedOutputTokens: 15,
    estimatedRequestCount: 2,
    unestimatedRequestCount: 0,
    tokenCountEvents: 2,
    duplicateTokenCountEvents: 1,
    toolCallCount: 1,
  });
  assert.equal(compareE2StaticFields(actual, reference).allEqual, true);
  assert.equal(compareE2Duration(actual, reference).equal, true);
  assert.equal(production.available, true);
  assert.equal(compareE2StaticFields(production, reference).allEqual, true);
  assert.equal(compareE2Duration({ capturedAt: at(6_000), metric: production }, reference).equal, true);
  assert.equal(boundary.available, true);
  assert.equal(boundary.staticFields.outputTokens, 7);
  assert.equal(boundary.staticFields.reasoningTokens, null);
  assert.equal(boundary.staticFields.requestDurationMs, null);
  assert.equal(boundary.staticFields.estimatedRequestCount, 0);
  assert.equal(boundary.staticFields.unestimatedRequestCount, 1);
  assert.equal(boundary.staticFields.tokenCountEvents, 1);
  assert.equal(boundary.staticFields.toolCallCount, 0);
  const e2Source = fs.readFileSync(path.join(repoRoot, "tools", "observe-probe-e2.mjs"), "utf8");
  assert.match(e2Source, /^import fs from "node:fs";/m);
  assert.doesNotMatch(e2Source, /observe-probe-core|observe-probe-|plugins\/|extractStopMetric/);
  assert.doesNotMatch(e2Source, /status-core|extractStopMetric/);
});

test("E2 performance output reports interleaving, IQR, and effect size without a threshold", () => {
  const result = analyzePerformanceSamples([10, 12, 11, 13], [9, 10, 10, 11], { random: () => 0.25 });
  assert.equal(result.enabled.n, 4);
  assert.equal(result.disabled.n, 4);
  assert.equal(result.effectSize.threshold, null);
  assert.equal(result.randomOrder.length, 8);
  assert.equal(result.conclusion, "distribution_observation_only");
});

test("E2 backfill and cross-run checks keep unavailable timing and deterministic invariants separate", () => {
  const missing = compareE2BackfilledTiming({ metric: {} }, { ttftMs: 12, completedDurationMs: 800 });
  assert.equal(missing.available, false);
  assert.equal(missing.equal, false);
  const equal = compareE2BackfilledTiming(
    { metric: { ttftMs: 12, completedDurationMs: 800, timingSource: "same-turn-backfill" } },
    { ttftMs: 12, completedDurationMs: 800, timingSource: "same-turn-backfill" }
  );
  assert.equal(equal.available, true);
  assert.equal(equal.equal, true);
  const invariants = assessProtocolInvariants([
    {
      discovery: { selectedThreadId: "thread-hash" },
      protocolInvariants: {
        threadIdStable: true,
        extraTurnCount: 0,
        noForkObserved: true,
        noReplayObserved: true,
      },
      unsubscribe: { ok: true },
    },
    {
      discovery: { selectedThreadId: "thread-hash" },
      protocolInvariants: {
        threadIdStable: true,
        extraTurnCount: 0,
        noForkObserved: true,
        noReplayObserved: true,
      },
      unsubscribe: { ok: true },
    },
  ]);
  assert.equal(invariants.threadIdStable, true);
  assert.equal(invariants.unsubscribeClean, true);
  assert.equal(invariants.tuiNormal, null);
});

test("endpoint security only accepts local transports", () => {
  assert.deepEqual(parseEndpoint("ws://127.0.0.1:4319"), {
    kind: "websocket",
    endpointKind: "ws",
    url: "ws://127.0.0.1:4319/",
    hostLoopback: true,
  });
  assert.throws(() => parseEndpoint("ws://collector.example:4319"), /endpoint_must_be_loopback/);
  assert.throws(() => parseEndpoint("ws://user:secret@127.0.0.1:4319"), /endpoint_credentials_not_allowed/);
});

test("capture directories stay outside v0.5 data and allocate unique runs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-phase-six-path-"));
  const v05Data = path.join(temp, "v05-data");
  const output = path.join(temp, "probe-output");
  assert.throws(
    () => assertIndependentOutputDirectory(path.join(v05Data, "status"), {
      TPS_PLUS_DATA_DIR: v05Data,
      PLUGIN_DATA: "",
    }),
    /output_directory_overlaps_v05_data/
  );
  const first = prepareRunDirectory(output);
  fs.writeFileSync(path.join(first, "probe-summary.json"), "{}", "utf8");
  const second = prepareRunDirectory(output);
  assert.notEqual(first, second);
  assert.match(path.basename(second), /^run-/);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("loopback WebSocket transport frames JSON without exposing transport errors", async () => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.instance = this;
      queueMicrotask(() => this.dispatch("open"));
    }

    addEventListener(event, listener) {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    dispatch(event, value = {}) {
      for (const listener of this.listeners.get(event) || []) listener(value);
    }

    send(value) {
      this.sent.push(value);
    }

    close() {
      this.dispatch("close");
    }
  }
  const received = [];
  const transport = new JsonRpcTransport("ws://127.0.0.1:4319", {
    WebSocketImpl: FakeWebSocket,
  });
  transport.onMessage = (message) => received.push(message);
  await transport.connect();
  transport.send({ method: "initialized" });
  FakeWebSocket.instance.dispatch("message", { data: '{"method":"future/notification","params":{}}' });
  assert.equal(FakeWebSocket.instance.sent[0], '{"method":"initialized"}');
  assert.deepEqual(received, [{ method: "future/notification", params: {} }]);
  transport.close("test_closed");
});

class FakeTransport {
  constructor({ routeServerRequest = false } = {}) {
    this.routeServerRequest = routeServerRequest;
    this.sent = [];
    this.connected = false;
    this.closed = false;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.onError = () => {};
  }

  async connect() {
    this.connected = true;
  }

  send(message) {
    this.sent.push(message);
    if (message.method === "initialize") {
      queueMicrotask(() => this.onMessage({
        id: message.id,
        result: { userAgent: "codex-cli 0.149.1" },
      }));
    } else if (message.method === "thread/loaded/list") {
      queueMicrotask(() => this.onMessage({ id: message.id, result: { data: ["thread-live"] } }));
    } else if (message.method === "thread/resume") {
      queueMicrotask(() => {
        this.onMessage({ id: message.id, result: { thread: { id: "thread-live", turns: [] } } });
        if (this.routeServerRequest) {
          this.onMessage({
            id: 777,
            method: "item/commandExecution/requestApproval",
            params: { command: "FAKE_PRIVATE_COMMAND" },
          });
          return;
        }
        setTimeout(() => {
          this.onMessage({
            method: "turn/started",
            params: { threadId: "thread-live", turn: { id: "turn-live", status: "inProgress" } },
          });
          this.onMessage({
            method: "item/started",
            params: {
              threadId: "thread-live",
              turnId: "turn-live",
              item: { id: "item-live", type: "agentMessage", text: "" },
            },
          });
          this.onMessage({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-live", turnId: "turn-live", itemId: "item-live", delta: "ok" },
          });
          this.onMessage({
            method: "item/completed",
            params: {
              threadId: "thread-live",
              turnId: "turn-live",
              item: { id: "item-live", type: "agentMessage", text: "ok" },
            },
          });
          this.onMessage({
            method: "turn/completed",
            params: { threadId: "thread-live", turn: { id: "turn-live", status: "completed" } },
          });
        }, 2);
      });
    } else if (message.method === "thread/unsubscribe") {
      queueMicrotask(() => this.onMessage({ id: message.id, result: { status: "unsubscribed" } }));
    }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.onClose(reason || "fake_closed");
  }
}

test("runner performs only allowed sends and keeps real E1 status pending", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-phase-six-runner-"));
  const fake = new FakeTransport();
  const result = await runProbe({
    endpoint: "ws://127.0.0.1:4319",
    out: path.join(temp, "run"),
    durationMs: 30,
    requestTimeoutMs: 100,
    maxBytes: 16_384,
    transportFactory: () => fake,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.e1.status, "pending");
  assert.equal(result.summary.daemonVersionSource, "initialize_response");
  assert.equal(result.summary.captureSuggested, false);
  const initialize = fake.sent.find((message) => message.method === "initialize");
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  assert.deepEqual(fake.sent.map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/loaded/list",
    "thread/resume",
    "thread/unsubscribe",
  ]);
  assert.equal(fake.sent.some((message) => /turn\/(start|interrupt|steer)/.test(message.method)), false);
  assert.equal(result.summary.turns[0].metrics.live.available, true);
  const capture = fs.readFileSync(path.join(result.runDirectory, "events.ndjson"), "utf8");
  assert.equal(capture.includes("ok"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("runner abort interrupts reconnect backoff before opening another connection", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-phase-six-reconnect-abort-"));
  const controller = new AbortController();
  const transports = [];
  class CloseAfterResumeTransport {
    constructor() {
      this.sent = [];
      this.closed = false;
      this.onMessage = () => {};
      this.onClose = () => {};
      this.onError = () => {};
    }

    async connect() {}

    send(message) {
      this.sent.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => this.onMessage({
          id: message.id,
          result: { userAgent: "codex-cli 0.149.1" },
        }));
      } else if (message.method === "thread/loaded/list") {
        queueMicrotask(() => this.onMessage({ id: message.id, result: { data: ["thread-live"] } }));
      } else if (message.method === "thread/resume") {
        queueMicrotask(() => {
          this.onMessage({ id: message.id, result: { thread: { id: "thread-live", turns: [] } } });
          setTimeout(() => this.close("unexpected_close"), 1);
        });
      }
    }

    close(reason) {
      if (this.closed) return;
      this.closed = true;
      this.onClose(reason || "fake_closed");
    }
  }
  const transportFactory = () => {
    const transport = new CloseAfterResumeTransport();
    transports.push(transport);
    return transport;
  };
  const abortTimer = setTimeout(() => controller.abort(), 20);
  const result = await runProbe({
    endpoint: "ws://127.0.0.1:4319",
    out: path.join(temp, "run"),
    durationMs: 500,
    requestTimeoutMs: 100,
    reconnectAttempts: 1,
    reconnectDelayMs: 100,
    maxBytes: 16_384,
    signal: controller.signal,
    transportFactory,
  });
  clearTimeout(abortTimer);
  assert.equal(result.exitCode, 0);
  assert.equal(transports.length, 1);
  assert.equal(transports[0].sent.filter((message) => message.method === "initialize").length, 1);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("runner exits nonzero and sends no response when a server request is routed", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-phase-six-request-"));
  const fake = new FakeTransport({ routeServerRequest: true });
  const result = await runProbe({
    endpoint: "ws://127.0.0.1:4319",
    out: path.join(temp, "run"),
    durationMs: 50,
    requestTimeoutMs: 100,
    maxBytes: 16_384,
    transportFactory: () => fake,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.e1.status, "fail");
  assert.equal(result.summary.serverRequests[0].kind, "approval");
  assert.equal(fake.sent.some((message) => message.id === 777), false);
  const contents = fs.readFileSync(path.join(result.runDirectory, "probe-summary.json"), "utf8");
  assert.equal(contents.includes("FAKE_PRIVATE_COMMAND"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("runner records a transport exception without persisting the raw error", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-phase-six-exception-"));
  const transportFactory = () => ({
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
    async connect() {
      throw Object.assign(new Error("PRIVATE_TRANSPORT_EXCEPTION"), { code: "transport_connect_failed" });
    },
    send() {},
    close() {},
  });
  const result = await runProbe({
    endpoint: "ws://127.0.0.1:4319",
    out: path.join(temp, "run"),
    durationMs: 10,
    requestTimeoutMs: 20,
    maxBytes: 16_384,
    transportFactory,
  });
  assert.equal(result.exitCode, 2);
  const contents = fs.readFileSync(result.summaryPath, "utf8");
  assert.equal(contents.includes("PRIVATE_TRANSPORT_EXCEPTION"), false);
  assert.equal(contents.includes("transport_connect_failed"), true);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("CLI argument parser requires endpoint and output and exposes capture-only schema option", () => {
  assert.throws(() => parseProbeArgs([]), /endpoint_and_out_required/);
  const options = parseProbeArgs([
    "--endpoint", "unix:///tmp/codex.sock",
    "--out", "capture",
    "--schema-version", "v99",
    "--unsubscribe-timeout-ms", "7",
    "--usage-terminal-verified",
  ]);
  assert.equal(options.schemaVersion, "v99");
  assert.equal(options.schemaVersionSource, "cli_argument");
  assert.equal(options.unsubscribeTimeoutMs, 7);
  assert.equal(options.usageTerminalVerified, true);
});

test("JsonRpcClient handles a synchronous fake response after registering the pending request", async () => {
  const sent = [];
  const transport = {
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
    connect: async () => {},
    send(message) {
      sent.push(message);
      this.onMessage({ id: message.id, result: { ok: true } });
    },
    close: () => {},
  };
  const client = new JsonRpcClient(transport, { requestTimeoutMs: 100 });
  const result = await client.request("initialize", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(sent[0].method, "initialize");
});

test("JsonRpcClient supports a short per-request timeout for best-effort unsubscribe", async () => {
  const transport = {
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
    connect: async () => {},
    send() {},
    close() {},
  };
  const client = new JsonRpcClient(transport, { requestTimeoutMs: 200 });
  const startedAt = Date.now();
  await assert.rejects(
    client.request("thread/unsubscribe", {}, { timeoutMs: 5 }),
    /rpc_request_timeout/
  );
  assert.equal(Date.now() - startedAt < 100, true);
  client.close("test_closed");
});
