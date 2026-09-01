import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectOtelCapture } from "../scripts/otel-inspect.mjs";
import { inspectOtelConfig, scanOtelCapture } from "../scripts/otel.mjs";

function varint(value) {
  let item = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(item & 0x7fn);
    item >>= 7n;
    if (item) byte |= 0x80;
    bytes.push(byte);
  } while (item);
  return Buffer.from(bytes);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function fieldVarint(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function fieldBytes(field, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([tag(field, 2), varint(buffer.length), buffer]);
}

function fieldFixed64(field, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([tag(field, 1), buffer]);
}

function fieldDouble(field, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return Buffer.concat([tag(field, 1), buffer]);
}

function message(parts) {
  return Buffer.concat(parts);
}

function anyString(value) {
  return fieldBytes(1, value);
}

function keyValue(key, value) {
  return message([fieldBytes(1, key), fieldBytes(2, anyString(value))]);
}

function histogramPoint({
  count = 1,
  sum,
  min = sum,
  max = sum,
  startTime = 1_000_000_000n,
  time = 2_000_000_000n,
  attributes = [],
}) {
  return message([
    fieldFixed64(2, startTime),
    fieldFixed64(3, time),
    fieldFixed64(4, count),
    fieldDouble(5, sum),
    ...attributes.map(([key, value]) => fieldBytes(9, keyValue(key, value))),
    fieldDouble(11, min),
    fieldDouble(12, max),
  ]);
}

function histogramMetric(name, points) {
  const histogram = message([
    ...points.map((point) => fieldBytes(1, histogramPoint(point))),
    fieldVarint(2, 1),
  ]);
  return message([fieldBytes(1, name), fieldBytes(3, "ms"), fieldBytes(9, histogram)]);
}

function metricsRequest() {
  const resource = message([fieldBytes(1, keyValue("service.name", "codex-cli"))]);
  const scope = fieldBytes(1, "codex");
  const scopeMetrics = message([
    fieldBytes(1, scope),
    fieldBytes(
      2,
      histogramMetric("codex.responses_api_engine_service_tbt.duration_ms", [{ sum: 20 }])
    ),
    fieldBytes(
      2,
      histogramMetric("codex.responses_api_engine_service_ttft.duration_ms", [{ sum: 500 }])
    ),
    fieldBytes(
      2,
      histogramMetric("codex.turn.token_usage", [
        { sum: 100, attributes: [["token_type", "output"]] },
      ])
    ),
    fieldBytes(2, histogramMetric("codex.turn.e2e_duration_ms", [{ sum: 2000 }])),
    fieldBytes(
      2,
      histogramMetric("secret.codex.turn.token_usage.private", [
        { sum: 1, attributes: [["token_type", "secret-token-value"]] },
      ])
    ),
  ]);
  const resourceMetrics = message([fieldBytes(1, resource), fieldBytes(2, scopeMetrics)]);
  return message([
    fieldBytes(1, resourceMetrics),
    // An unknown field containing a tempting ASCII key must not be treated as
    // a structural metric attribute.
    fieldBytes(99, "request.id"),
  ]);
}

function logRecord(conversationId, eventName = "codex.sse_event", eventKind = "response.completed") {
  return message([
    fieldBytes(5, anyString("event")),
    fieldBytes(6, keyValue("event.name", eventName)),
    fieldBytes(6, keyValue("event.kind", eventKind)),
    fieldBytes(6, keyValue("conversation.id", conversationId)),
    fieldBytes(6, keyValue("request.id", `request-${conversationId}`)),
  ]);
}

function logsRequest(conversationIds = ["secret-session"]) {
  const resource = message([fieldBytes(1, keyValue("service.name", "codex-cli"))]);
  const scopeLogs = message(conversationIds.map((id) => fieldBytes(2, logRecord(id))));
  return fieldBytes(1, message([fieldBytes(1, resource), fieldBytes(2, scopeLogs)]));
}

function writeCapture(directory, stem, url, body, receiverId = null) {
  const bodyFile = `${stem}.bin`;
  fs.writeFileSync(path.join(directory, bodyFile), body);
  fs.writeFileSync(
    path.join(directory, `${stem}.meta.json`),
    JSON.stringify({ url, contentType: "application/x-protobuf", bodyFile, receiverId })
  );
}

test("structured OTLP inspection derives native approximate TPS without inventing request joinability", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-otlp-"));
  try {
    writeCapture(temp, "metrics", "/v1/metrics", metricsRequest(), "a".repeat(32));
    writeCapture(temp, "logs", "/v1/logs?secret=query-value", logsRequest(), "a".repeat(32));
    const report = inspectOtelCapture(temp);
    assert.equal(report.decodedMetricPayloads, 1);
    assert.equal(report.decodedLogPayloads, 1);
    assert.deepEqual(report.parseErrors, []);
    assert.equal(report.nativeTiming.serviceTbt.meanMs, 20);
    assert.equal(report.nativeTiming.serviceTbt.sumMs, 20);
    assert.equal(report.nativeTiming.serviceTbt.minMs, 20);
    assert.equal(report.nativeTiming.serviceTbt.maxMs, 20);
    assert.equal(report.nativeTiming.serviceTbt.pointCount, 1);
    assert.deepEqual(report.nativeTiming.serviceTbt.windows, [
      {
        startTime: "1970-01-01T00:00:01.000Z",
        endTime: "1970-01-01T00:00:02.000Z",
        count: 1,
        sumMs: 20,
        minMs: 20,
        maxMs: 20,
        temporality: "delta",
      },
    ]);
    assert.equal(report.nativeTiming.serviceTtft.meanMs, 500);
    assert.equal(report.nativeTiming.turnE2e.observations, 1);
    assert.equal(report.nativeTiming.tokenUsage.output.sum, 100);
    assert.equal(report.nativeTiming.approximateTpsFromServiceTbt, 50);
    assert.equal(report.perRequestJoinable, false);
    assert.equal(report.captureIsolation.level, "single-conversation-observed");
    assert.equal(report.captureIsolation.distinctConversationCount, 1);
    assert.deepEqual(report.transportSignals, ["codex.sse_event"]);
    assert.equal(report.captureIsolation.singleTurnCandidateEligible, true);
    assert.equal(report.captureIsolation.evidenceLevel, "isolated-window-candidate");
    assert.equal(report.directMetricRequestKeyObserved, false);
    assert.deepEqual(report.requestKeyNames, []);
    assert.equal(JSON.stringify(report).includes("secret-session"), false);
    assert.equal(JSON.stringify(report).includes("secret-request"), false);
    assert.equal(JSON.stringify(report).includes("secret-token-value"), false);
    assert.equal(JSON.stringify(report).includes("secret.codex"), false);
    assert.equal(JSON.stringify(report).includes("query-value"), false);
    assert.equal(scanOtelCapture(temp).joinabilityInspection, "structured-otlp-protobuf");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("OTel inspection detects concurrent conversations without exposing their identifiers", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-otlp-concurrent-"));
  try {
    writeCapture(temp, "metrics", "/v1/metrics", metricsRequest(), "b".repeat(32));
    writeCapture(temp, "logs", "/v1/logs", logsRequest(["conversation-a", "conversation-b"]), "b".repeat(32));
    const report = inspectOtelCapture(temp);
    assert.equal(report.captureIsolation.level, "concurrent-conversations-observed");
    assert.equal(report.captureIsolation.distinctConversationCount, 2);
    assert.equal(report.captureIsolation.singleTurnCandidateEligible, false);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("conversation-a"), false);
    assert.equal(serialized.includes("conversation-b"), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("OTel config inspection distinguishes log and metric exporters", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-otel-config-"));
  try {
    const config = path.join(temp, "config.toml");
    fs.writeFileSync(
      config,
      '[otel]\nexporter = "none"\nmetrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics" } }\n',
      "utf8"
    );
    const report = inspectOtelConfig(config);
    assert.equal(report.exporter, "none");
    assert.equal(report.metricsExporter, "otlp-http");
    assert.equal(report.metricsEndpoint, "http://127.0.0.1:4318/v1/metrics");
    assert.equal(report.metricsEndpointLoopback, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
