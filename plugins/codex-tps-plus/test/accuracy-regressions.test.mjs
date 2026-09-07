import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  backfillTurnCompletion, createTurnCompletionReader, extractStopMetric,
  formatStatusLine, readSessionStatus, recordStopMetric, summarizeStatusRecords,
} from "../scripts/status-core.mjs";

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tps-accuracy-"));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const event = (payload) => JSON.stringify({ type: "event_msg", payload }) + "\n";
const complete = (extra = {}) => event({
  type: "task_complete", turn_id: "turn", duration_ms: 3500,
  time_to_first_token_ms: 500, ...extra,
});
const metric = { available: true, outputTokens: 200, reasoningTokens: 40, durationMs: 3000 };

test("equal independent usage without cumulative evidence fails closed instead of guessing", (t) => {
  const file = path.join(workspace(t), "rollout.jsonl");
  for (const totals of [[undefined, undefined], [100, undefined], [100, 200]]) {
    fs.writeFileSync(file, event({ type: "task_started", turn_id: "turn", started_at: 1000 }) +
      totals.map((total, index) =>
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", id: String(index) } }) + "\n" +
        event({ type: "token_count", info: {
          last_token_usage: { output_tokens: 100, reasoning_output_tokens: 20 },
          ...(total === undefined ? {} : { total_token_usage: { output_tokens: total } }),
        } })).join(""));
    const result = extractStopMetric(file, "turn", { nowMs: 1003000 });
    if (totals.includes(undefined)) {
      assert.equal(result.available, false);
      assert.equal(result.reason, "token_usage_deduplication_unavailable");
    } else {
      assert.equal(result.outputTokens, 200);
      assert.equal(result.nonReasoningOutputTokens, 160);
      assert.equal(result.duplicateTokenCountEvents, 0);
    }
  }
});

test("repeated Stop preserves completion timing, session weighting and turn order", (t) => {
  const dataDir = workspace(t);
  const args = { dataDir, sessionId: "session", turnId: "turn" };
  recordStopMetric({ ...args, metric, capturedAt: new Date(1000) });
  backfillTurnCompletion({ ...args, completion: {
    available: true, ttftMs: 500, completedDurationMs: 3500,
  }, capturedAt: new Date(2000) });
  recordStopMetric({ ...args, turnId: "next", metric, capturedAt: new Date(3000) });
  recordStopMetric({ ...args, metric: { ...metric, durationMs: 5000 }, capturedAt: new Date(4000) });
  const status = readSessionStatus(args);
  assert.equal(status.turns, 2);
  assert.equal(status.latest.capturedAt, new Date(3000).toISOString());
  assert.equal(status.session.nonReasoningDurationMs, 6500);
  assert.equal(status.session.nonReasoningThroughput, 320 / 6.5);
  assert.equal(status.mostRecentTtft.ttftMs, 500);
  assert.equal(status.mostRecentTtft.completedDurationMs, 3500);
});

test("a stale provisional file cannot mask concurrently written completion evidence", (t) => {
  const dataDir = workspace(t);
  const args = { dataDir, sessionId: "session", turnId: "turn" };
  recordStopMetric({ ...args, metric, capturedAt: new Date(1000) });
  const directory = path.join(dataDir, "status", fs.readdirSync(path.join(dataDir, "status"))[0]);
  const original = fs.readdirSync(directory)[0];
  const stale = fs.readFileSync(path.join(directory, original));
  backfillTurnCompletion({ ...args, completion: { available: true, ttftMs: 500, completedDurationMs: 3500 } });
  const stalePath = path.join(directory, original.replace(/^\d+-/, "9999999999999-"));
  fs.writeFileSync(stalePath, stale);
  fs.utimesSync(stalePath, new Date("2099-01-01"), new Date("2099-01-01"));
  const status = readSessionStatus(args);
  assert.equal(status.latest.durationMs, 3500);
  assert.equal(status.latest.ttftMs, 500);
});

test("completion reader scans a long unchanged transcript once, then only appended bytes", (t) => {
  const file = path.join(workspace(t), "rollout.jsonl");
  fs.writeFileSync(file, (event({ type: "irrelevant", padding: "x".repeat(1000) })).repeat(18000));
  let bytes = 0;
  const reader = createTurnCompletionReader(file, "turn", { fileSystem: {
    ...fs, readSync(...args) { const n = fs.readSync(...args); bytes += n; return n; },
  } });
  assert.equal(reader().available, false);
  const initialBytes = bytes;
  assert.ok(initialBytes <= 16 * 1024 * 1024);
  for (let i = 0; i < 10; i++) assert.equal(reader().available, false);
  assert.equal(bytes, initialBytes);
  const appended = complete();
  fs.appendFileSync(file, appended);
  assert.equal(reader().completedDurationMs, 3500);
  assert.equal(bytes - initialBytes, Buffer.byteLength(appended));
});

test("completion reader retains partial UTF-8 lines and supports completion without a turn id", (t) => {
  const file = path.join(workspace(t), "rollout.jsonl");
  fs.writeFileSync(file, event({ type: "task_started", turn_id: "turn" }));
  const reader = createTurnCompletionReader(file, "turn");
  assert.equal(reader().available, false);
  const bytes = Buffer.from(complete({ turn_id: undefined, note: "中文" }).trimEnd());
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  fs.appendFileSync(file, bytes.subarray(0, split));
  assert.equal(reader().available, false);
  fs.appendFileSync(file, bytes.subarray(split));
  assert.equal(reader().ttftMs, 500);
  fs.appendFileSync(file, "\n");
  assert.equal(reader().completedDurationMs, 3500);
});

test("completion reader recovers from truncation, replacement and temporary absence", (t) => {
  const directory = workspace(t);
  const file = path.join(directory, "rollout.jsonl");
  fs.writeFileSync(file, event({ type: "ignored", padding: "x".repeat(1000) }));
  const reader = createTurnCompletionReader(file, "turn");
  assert.equal(reader().available, false);
  fs.writeFileSync(file, complete());
  assert.equal(reader().ttftMs, 500);
  const replacement = path.join(directory, "replacement.jsonl");
  fs.writeFileSync(replacement, complete({ time_to_first_token_ms: 700 }));
  fs.renameSync(replacement, file);
  assert.equal(reader().ttftMs, 700);
  fs.unlinkSync(file);
  assert.equal(reader().reason, "transcript_unreadable");
  fs.writeFileSync(file, complete({ time_to_first_token_ms: 900 }));
  assert.equal(reader().ttftMs, 900);
});

test("older TTFT is explicitly recent-valid, even when intervening timing is missing", () => {
  const records = [
    { ...metric, ttftMs: 500 }, { ...metric }, { ...metric },
  ];
  const status = summarizeStatusRecords(records);
  assert.equal(status.mostRecentTtft.isLatestTurn, false);
  assert.match(formatStatusLine(status), /最近有效 TTFT 0\.5s$/);
  assert.doesNotMatch(formatStatusLine(status), /上轮 TTFT/);
  records[2].ttftMs = 700;
  assert.match(formatStatusLine(summarizeStatusRecords(records)), /· TTFT 0\.7s$/);
});
