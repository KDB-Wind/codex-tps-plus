import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  backfillTurnCompletion,
  captureStopStatus,
  extractStopMetric,
  extractTurnCompletion,
  formatStatusLine,
  nativeOtelReferenceFromInspection,
  pruneStatusFiles,
  readTail,
  readSessionStatus,
  recordStopMetric,
  summarizeStatusRecords,
} from "../scripts/status-core.mjs";
import { waitAndBackfill } from "../hooks/backfill.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = (name) => path.join(root, "test", "fixtures", name);

test("readTail parses only bytes actually returned by a short read", () => {
  const fakeFs = {
    statSync: () => ({ size: 8 }),
    openSync: () => 42,
    readSync: (_handle, buffer) => {
      buffer.fill(0x78);
      buffer.write("{}\n", 0, "utf8");
      return 3;
    },
    closeSync: () => {},
  };
  assert.deepEqual(readTail("rollout.jsonl", 8, fakeFs), {
    text: "{}\n",
    start: 0,
    sizeBytes: 8,
  });
});

test("status pruning degrades when its directory cannot be listed", () => {
  const fakeFs = {
    readdirSync: () => {
      throw new Error("simulated directory race");
    },
  };
  assert.doesNotThrow(() => pruneStatusFiles("status-dir", fakeFs));
});

test("Stop metric uses output tokens once and wall time from task start", () => {
  const metric = extractStopMetric(fixture("stop-before-complete.jsonl"), "turn-stop-1", {
    nowMs: Date.parse("2026-08-30T12:00:03.000Z"),
  });
  assert.equal(metric.available, true);
  assert.equal(metric.outputTokens, 10);
  assert.equal(metric.reasoningTokens, 4);
  assert.equal(metric.durationMs, 2000);
  assert.equal(metric.throughput, 5);
  assert.equal(metric.tokenCountEvents, 1);
});

test("completed transcript exposes delayed turn TTFT without reading message content", () => {
  const completion = extractTurnCompletion(fixture("legacy-session.jsonl"), "turn-legacy-1");
  assert.equal(completion.available, true);
  assert.equal(completion.ttftMs, 900);
  assert.equal(completion.completedDurationMs, 3000);
  assert.equal(completion.source, "transcript-task-complete-delayed");
});

test("Stop-time transcript deliberately reports TTFT as not complete yet", () => {
  const completion = extractTurnCompletion(fixture("stop-before-complete.jsonl"), "turn-stop-1");
  assert.equal(completion.available, false);
  assert.equal(completion.reason, "turn_not_complete");
});

test("explicit null timing is missing rather than zero milliseconds", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-null-ttft-"));
  const transcript = path.join(temp, "rollout.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ payload: { type: "task_started", turn_id: "turn-null" } }),
      JSON.stringify({
        payload: {
          type: "task_complete",
          turn_id: "turn-null",
          time_to_first_token_ms: null,
          duration_ms: 1000,
        },
      }),
    ].join("\n")
  );
  const completion = extractTurnCompletion(transcript, "turn-null");
  assert.equal(completion.available, false);
  assert.equal(completion.reason, "ttft_missing_or_invalid");
  fs.rmSync(temp, { recursive: true, force: true });
});

test("re-emitted token_count usage is deduplicated by cumulative output", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-duplicate-"));
  const transcript = path.join(temp, "rollout.jsonl");
  const records = [
    { timestamp: "2026-08-30T12:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-dup", started_at: 1788091201 } },
    { timestamp: "2026-08-30T12:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 100, reasoning_output_tokens: 40 }, total_token_usage: { output_tokens: 900 } } } },
    { timestamp: "2026-08-30T12:00:02.100Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 100, reasoning_output_tokens: 40 }, total_token_usage: { output_tokens: 900 } } } },
    { timestamp: "2026-08-30T12:00:03.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 20, reasoning_output_tokens: 5 }, total_token_usage: { output_tokens: 920 } } } },
  ];
  fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const metric = extractStopMetric(transcript, "turn-dup", {
    nowMs: Date.parse("2026-08-30T12:00:04.000Z"),
  });
  assert.equal(metric.outputTokens, 120);
  assert.equal(metric.reasoningTokens, 45);
  assert.equal(metric.tokenCountEvents, 2);
  assert.equal(metric.duplicateTokenCountEvents, 1);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("request throughput includes TTFT, excludes tool execution, and weights request intervals", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-request-"));
  const transcript = path.join(temp, "rollout.jsonl");
  const records = [
    { timestamp: "2026-08-30T12:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-approx", started_at: 1788091200 } },
    { timestamp: "2026-08-30T12:00:02.000Z", type: "response_item", payload: { type: "custom_tool_call", status: "completed" } },
    { timestamp: "2026-08-30T12:00:12.000Z", type: "response_item", payload: { type: "custom_tool_call_output" } },
    { timestamp: "2026-08-30T12:00:12.001Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 100, reasoning_output_tokens: 40 }, total_token_usage: { output_tokens: 100 } } } },
    { timestamp: "2026-08-30T12:00:14.001Z", type: "response_item", payload: { type: "message", role: "assistant" } },
    { timestamp: "2026-08-30T12:00:14.010Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 100, reasoning_output_tokens: 20 }, total_token_usage: { output_tokens: 200 } } } },
  ];
  fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const metric = extractStopMetric(transcript, "turn-approx", {
    nowMs: Date.parse("2026-08-30T12:00:20.000Z"),
  });
  assert.equal(metric.outputTokens, 200);
  assert.equal(metric.durationMs, 20_000);
  assert.equal(metric.throughput, 10);
  assert.equal(metric.requestDurationMs, 4_000);
  assert.equal(metric.estimatedOutputTokens, 200);
  assert.equal(metric.estimatedRequestCount, 2);
  assert.equal(metric.unestimatedRequestCount, 0);
  assert.equal(metric.requestThroughput, 50);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("session average is token-and-duration weighted, not an arithmetic mean", () => {
  const status = summarizeStatusRecords([
    { outputTokens: 100, durationMs: 1000, estimatedOutputTokens: 100, estimatedRequestCount: 1, requestDurationMs: 1000, capturedAt: "2026-08-30T12:00:00.000Z" },
    { outputTokens: 100, durationMs: 9000, estimatedOutputTokens: 100, estimatedRequestCount: 1, requestDurationMs: 9000, capturedAt: "2026-08-30T12:01:00.000Z" },
  ]);
  assert.equal(status.latest.throughput, 100 / 9);
  assert.equal(status.session.throughput, 20);
  assert.equal(status.latest.requestThroughput, 100 / 9);
  assert.equal(status.session.requestThroughput, 20);
  assert.equal(status.requestThroughputIncludesTtft, true);
  assert.equal(status.isPureGenerationTps, false);
  assert.equal(status.latest.shortResponseReference, true);
});

test("short-response reference marker stops at 128 output tokens per request", () => {
  const below = summarizeStatusRecords([
    { outputTokens: 127, durationMs: 1000, estimatedOutputTokens: 127, estimatedRequestCount: 1, requestDurationMs: 1000, capturedAt: "2026-08-30T12:00:00.000Z" },
  ]);
  const boundary = summarizeStatusRecords([
    { outputTokens: 128, durationMs: 1000, estimatedOutputTokens: 128, estimatedRequestCount: 1, requestDurationMs: 1000, capturedAt: "2026-08-30T12:00:00.000Z" },
  ]);
  assert.equal(below.latest.shortResponseReference, true);
  assert.equal(boundary.latest.shortResponseReference, false);
});

test("v2 request-duration records remain readable without reviving the TPS label", () => {
  const status = summarizeStatusRecords([
    { outputTokens: 200, durationMs: 5000, estimatedOutputTokens: 200, estimatedRequestCount: 1, inferenceDurationMs: 4000, capturedAt: "2026-08-30T12:00:00.000Z" },
  ]);
  assert.equal(status.latest.requestDurationMs, 4000);
  assert.equal(status.latest.requestThroughput, 50);
  assert.equal(status.latest.approximateTps, undefined);
  assert.doesNotMatch(formatStatusLine(status), /TPS|近似/);
});

test("incomplete request coverage falls back to whole-turn throughput", () => {
  const status = summarizeStatusRecords([
    {
      outputTokens: 200,
      durationMs: 5000,
      estimatedOutputTokens: 100,
      estimatedRequestCount: 1,
      unestimatedRequestCount: 1,
      requestDurationMs: 1000,
      capturedAt: "2026-08-30T12:00:00.000Z",
    },
  ]);
  assert.equal(status.metric, "end_to_end_turn_throughput");
  assert.equal(status.requestThroughputIncludesTtft, false);
  assert.equal(status.latest.requestCoverageComplete, false);
  assert.equal(status.latest.requestThroughput, null);
  assert.equal(status.session.requestThroughput, null);
  assert.equal(formatStatusLine(status), "⚡ 整轮吞吐 40.0 tok/s · 会话吞吐 40.0 tok/s · 输出 200 tok · 耗时 5.0s");
});

test("session records are redacted, deduplicated by turn, and queryable", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-status-"));
  const base = {
    available: true,
    source: "stop-wall-clock",
    outputTokens: 100,
    reasoningTokens: 40,
    durationMs: 1000,
    tokenCountEvents: 1,
    toolCallCount: 0,
  };
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-secret",
    turnId: "turn-secret",
    metric: base,
    capturedAt: new Date("2026-08-30T12:00:00.000Z"),
  });
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-secret",
    turnId: "turn-secret",
    metric: { ...base, outputTokens: 200, durationMs: 2000 },
    capturedAt: new Date("2026-08-30T12:00:01.000Z"),
  });
  const status = readSessionStatus({ dataDir: temp, sessionId: "session-secret" });
  assert.equal(status.turns, 1);
  assert.equal(status.latest.outputTokens, 200);
  const serialized = fs
    .readdirSync(temp, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".json"))
    .map((name) => fs.readFileSync(path.join(temp, name), "utf8"))
    .join("\n");
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("turn-secret"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("delayed TTFT backfill updates the same redacted turn and session mean", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-ttft-"));
  const metric = {
    available: true,
    source: "stop-wall-clock",
    outputTokens: 100,
    reasoningTokens: 40,
    durationMs: 3000,
    tokenCountEvents: 1,
    toolCallCount: 0,
  };
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-secret",
    turnId: "turn-legacy-1",
    metric,
    capturedAt: new Date("2026-08-30T10:00:04.000Z"),
  });
  const completion = extractTurnCompletion(fixture("legacy-session.jsonl"), "turn-legacy-1");
  const result = backfillTurnCompletion({
    dataDir: temp,
    sessionId: "session-secret",
    turnId: "turn-legacy-1",
    completion,
    capturedAt: new Date("2026-08-30T10:00:05.000Z"),
  });
  assert.equal(result.updated, true);
  const status = readSessionStatus({ dataDir: temp, sessionId: "session-secret" });
  assert.equal(status.turns, 1);
  assert.equal(status.latest.ttftMs, 900);
  assert.equal(status.latest.timingSource, "task_complete_direct");
  assert.equal(status.latest.completedDurationMs, 3000);
  assert.equal(status.session.ttftMeasuredTurns, 1);
  assert.equal(status.session.ttftMeanMs, 900);
  assert.equal(status.mostRecentTtft.isLatestTurn, true);
  assert.match(formatStatusLine(status), /· TTFT 0\.9s$/);
  const serialized = fs
    .readdirSync(temp, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".json"))
    .map((name) => fs.readFileSync(path.join(temp, name), "utf8"))
    .join("\n");
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("turn-legacy-1"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("background Stop worker backfills TTFT and always remains informational", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-background-"));
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-background",
    turnId: "turn-legacy-1",
    metric: {
      available: true,
      source: "stop-wall-clock",
      outputTokens: 10,
      reasoningTokens: 4,
      durationMs: 3000,
      tokenCountEvents: 1,
      toolCallCount: 0,
    },
  });
  const result = await waitAndBackfill(
    {
      session_id: "session-background",
      turn_id: "turn-legacy-1",
      transcript_path: fixture("legacy-session.jsonl"),
    },
    { dataDir: temp, maxWaitMs: 100, pollMs: 10 }
  );
  assert.equal(result.updated, true);
  assert.equal(
    readSessionStatus({ dataDir: temp, sessionId: "session-background" }).latest.ttftMs,
    900
  );
  assert.equal(
    readSessionStatus({ dataDir: temp, sessionId: "session-background" }).latest.timingSource,
    "task_complete_async"
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("a new synchronous Stop line labels the last completed timing as previous-turn TTFT", () => {
  const status = summarizeStatusRecords([
    {
      turnId: "previous",
      outputTokens: 100,
      durationMs: 2000,
      ttftMs: 800,
      completedDurationMs: 1900,
      capturedAt: "2026-08-30T12:00:00.000Z",
    },
    {
      turnId: "current",
      outputTokens: 200,
      durationMs: 4000,
      capturedAt: "2026-08-30T12:01:00.000Z",
    },
  ]);
  assert.equal(status.latest.ttftMs, null);
  assert.equal(status.mostRecentTtft.isLatestTurn, false);
  assert.match(formatStatusLine(status), /· 上轮 TTFT 0\.8s$/);
});

test("synchronous Stop recovers the previous turn TTFT when the async hook did not run", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-sync-recovery-"));
  const transcript = path.join(temp, "rollout.jsonl");
  fs.writeFileSync(
    transcript,
    `${[
      { timestamp: "2026-08-30T12:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-previous", started_at: 1788091201 } },
      { timestamp: "2026-08-30T12:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 20, reasoning_output_tokens: 5 }, total_token_usage: { output_tokens: 20 } } } },
      { timestamp: "2026-08-30T12:00:04.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-previous", duration_ms: 3000, time_to_first_token_ms: 900 } },
      { timestamp: "2026-08-30T12:01:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-current", started_at: 1788091261 } },
      { timestamp: "2026-08-30T12:01:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 30, reasoning_output_tokens: 6 }, total_token_usage: { output_tokens: 50 } } } },
    ].map(JSON.stringify).join("\n")}\n`,
    "utf8"
  );
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-recovery",
    turnId: "turn-previous",
    metric: {
      available: true,
      source: "transcript-request-intervals-including-ttft",
      outputTokens: 20,
      reasoningTokens: 5,
      durationMs: 3000,
      requestDurationMs: 1000,
      estimatedOutputTokens: 20,
      estimatedRequestCount: 1,
      unestimatedRequestCount: 0,
      tokenCountEvents: 1,
      toolCallCount: 0,
    },
    capturedAt: new Date("2026-08-30T12:00:03.000Z"),
  });

  const result = captureStopStatus(
    {
      session_id: "session-recovery",
      turn_id: "turn-current",
      transcript_path: transcript,
    },
    { dataDir: temp, nowMs: Date.parse("2026-08-30T12:01:03.000Z") }
  );

  assert.equal(result.previousTurnBackfill.updated, true);
  assert.equal(result.status.turns, 2);
  assert.equal(result.status.session.ttftMeasuredTurns, 1);
  assert.equal(result.status.mostRecentTtft.ttftMs, 900);
  assert.equal(result.status.mostRecentTtft.timingSource, "task_complete_sync_recovery");
  assert.equal(result.status.mostRecentTtft.isLatestTurn, false);
  assert.match(result.line, /· 上轮 TTFT 0\.9s$/);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("background hook executable returns strict empty Stop JSON", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-background-hook-"));
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-executable",
    turnId: "turn-legacy-1",
    metric: {
      available: true,
      source: "stop-wall-clock",
      outputTokens: 10,
      reasoningTokens: 4,
      durationMs: 3000,
      tokenCountEvents: 1,
      toolCallCount: 0,
    },
  });
  const stdout = execFileSync(process.execPath, [path.join(root, "hooks", "backfill.mjs"), "Stop"], {
    input: JSON.stringify({
      session_id: "session-executable",
      turn_id: "turn-legacy-1",
      transcript_path: fixture("legacy-session.jsonl"),
    }),
    env: { ...process.env, TPS_PLUS_DATA_DIR: temp },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(stdout), {});
  assert.equal(
    readSessionStatus({ dataDir: temp, sessionId: "session-executable" }).latest.ttftMs,
    900
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("background hook executes through an installed directory junction", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-junction-hook-"));
  const linkedRoot = path.join(temp, "linked-plugin");
  fs.symlinkSync(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  recordStopMetric({
    dataDir: temp,
    sessionId: "session-junction",
    turnId: "turn-legacy-1",
    metric: {
      available: true,
      source: "stop-wall-clock",
      outputTokens: 10,
      reasoningTokens: 4,
      durationMs: 3000,
      tokenCountEvents: 1,
      toolCallCount: 0,
    },
  });
  const stdout = execFileSync(
    process.execPath,
    [path.join(linkedRoot, "hooks", "backfill.mjs"), "Stop"],
    {
      input: JSON.stringify({
        session_id: "session-junction",
        turn_id: "turn-legacy-1",
        transcript_path: fixture("legacy-session.jsonl"),
      }),
      env: { ...process.env, TPS_PLUS_DATA_DIR: temp },
      encoding: "utf8",
    }
  );
  assert.deepEqual(JSON.parse(stdout), {});
  assert.equal(readSessionStatus({ dataDir: temp, sessionId: "session-junction" }).latest.ttftMs, 900);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("unattributed native OTel TBT is labeled as a capture reference, never current TPS", () => {
  const nativeOtel = nativeOtelReferenceFromInspection({
    perRequestJoinable: false,
    rawCaptureSensitive: true,
    nativeTiming: {
      serviceTbt: { observations: 2, meanMs: 12.5 },
      turnE2e: { observations: 2 },
      tokenUsage: { output: { observations: 2, sum: 400 } },
      approximateTpsFromServiceTbt: 80,
    },
  });
  assert.equal(nativeOtel.available, true);
  assert.equal(nativeOtel.confidence, "capture-aggregate");
  assert.equal(nativeOtel.shortOutputReference, false);
  assert.equal(nativeOtel.approximateTps, 80);
  assert.equal(nativeOtel.currentTurnAttributed, false);
  assert.equal(nativeOtel.exactPerRequestTps, false);
  const status = summarizeStatusRecords([
    { outputTokens: 100, durationMs: 2000, capturedAt: "2026-08-30T12:00:00.000Z" },
  ]);
  assert.match(
    formatStatusLine({ ...status, nativeOtel }),
    /原生生成 TPS ≈80\.0（TBT 推算·捕获参考·未归轮）$/
  );
});

test("an isolated OTel window remains an unattributed short-output candidate", () => {
  const nativeOtel = nativeOtelReferenceFromInspection({
    perRequestJoinable: false,
    rawCaptureSensitive: true,
    captureIsolation: { singleTurnCandidateEligible: true },
    nativeTiming: {
      serviceTbt: { observations: 1, meanMs: 100 },
      turnE2e: { observations: 1 },
      tokenUsage: { output: { observations: 1, sum: 5 } },
      approximateTpsFromServiceTbt: 10,
    },
  });
  assert.equal(nativeOtel.confidence, "isolated-window-candidate");
  assert.equal(nativeOtel.shortOutputReference, true);
  assert.equal(nativeOtel.currentTurnAttributed, false);
  const status = summarizeStatusRecords([
    { outputTokens: 5, durationMs: 2000, capturedAt: "2026-09-01T00:00:00.000Z" },
  ]);
  assert.match(
    formatStatusLine({ ...status, nativeOtel }),
    /原生生成 TPS ≈10\.0（TBT 推算·单轮候选·未归轮·短输出）$/
  );
});

test("Stop capture labels request-interval throughput as including TTFT", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-capture-"));
  const result = captureStopStatus(
    {
      session_id: "session-one",
      turn_id: "turn-stop-1",
      transcript_path: fixture("stop-before-complete.jsonl"),
    },
    { dataDir: temp, nowMs: Date.parse("2026-08-30T12:00:03.000Z") }
  );
  assert.equal(result.status.session.throughput, 5);
  assert.equal(result.line, "⚡ 请求内吞吐 10.0 tok/s（含首字·短回复参考） · 会话请求内 10.0 tok/s · 整轮 5.0 tok/s · 输出 10 tok · 轮耗时 2.0s");
  assert.equal(result.status.isPureGenerationTps, false);
  assert.equal(result.status.requestThroughputIncludesTtft, true);
  assert.equal(formatStatusLine(result.status, "上轮整轮吞吐").startsWith("⚡ 请求内吞吐 10.0"), true);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("collector surfaces request throughput as strict Stop JSON", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-hook-status-"));
  const collector = path.join(root, "hooks", "collector.mjs");
  const transcript = path.join(temp, "rollout.jsonl");
  const startedAtMs = Date.now() - 2000;
  fs.writeFileSync(
    transcript,
    `${[
      { timestamp: new Date(startedAtMs).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn-hook", started_at: startedAtMs / 1000 } },
      { timestamp: new Date(startedAtMs + 1000).toISOString(), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: 10, reasoning_output_tokens: 4 }, total_token_usage: { output_tokens: 10 } } } },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
  const stdout = execFileSync(process.execPath, [collector, "Stop"], {
    input: JSON.stringify({
      session_id: "session-hook",
      turn_id: "turn-hook",
      hook_event_name: "Stop",
      transcript_path: transcript,
    }),
    env: {
      ...process.env,
      TPS_PLUS_DATA_DIR: temp,
    },
    encoding: "utf8",
  });
  const output = JSON.parse(stdout);
  assert.match(output.systemMessage, /^⚡ 请求内吞吐 /);
  assert.match(output.systemMessage, /含首字/);
  assert.match(output.systemMessage, /· 整轮 /);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("status CLI reports no data without a session id", () => {
  const script = path.join(root, "scripts", "status.mjs");
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  const output = JSON.parse(execFileSync(process.execPath, [script, "--json"], { env, encoding: "utf8" }));
  assert.equal(output.available, false);
  assert.equal(output.reason, "session_id_unavailable");
});
