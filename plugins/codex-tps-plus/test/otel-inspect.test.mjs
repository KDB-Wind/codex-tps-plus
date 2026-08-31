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

function histogramPoint({ count = 1, sum, attributes = [] }) {
  return message([
    fieldFixed64(2, 1_000_000_000n),
    fieldFixed64(3, 2_000_000_000n),
    fieldFixed64(4, count),
    fieldDouble(5, sum),
    ...attributes.map(([key, value]) => fieldBytes(9, keyValue(key, value))),
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

function logsRequest() {
  const resource = message([fieldBytes(1, keyValue("service.name", "codex-cli"))]);
  const record = message([
    fieldBytes(5, anyString("event")),
    fieldBytes(6, keyValue("event.name", "codex.sse_event")),
    fieldBytes(6, keyValue("event.kind", "response.completed")),
    fieldBytes(6, keyValue("conversation.id", "secret-session")),
    fieldBytes(6, keyValue("request.id", "secret-request")),
  ]);
  const scopeLogs = fieldBytes(2, record);
  return fieldBytes(1, message([fieldBytes(1, resource), fieldBytes(2, scopeLogs)]));
}

function writeCapture(directory, stem, url, body) {
  const bodyFile = `${stem}.bin`;
  fs.writeFileSync(path.join(directory, bodyFile), body);
  fs.writeFileSync(
    path.join(directory, `${stem}.meta.json`),
    JSON.stringify({ url, contentType: "application/x-protobuf", bodyFile })
  );
}

test("structured OTLP inspection derives native approximate TPS without inventing request joinability", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-otlp-"));
  try {
    writeCapture(temp, "metrics", "/v1/metrics", metricsRequest());
    writeCapture(temp, "logs", "/v1/logs?secret=query-value", logsRequest());
    const report = inspectOtelCapture(temp);
    assert.equal(report.decodedMetricPayloads, 1);
    assert.equal(report.decodedLogPayloads, 1);
    assert.deepEqual(report.parseErrors, []);
    assert.equal(report.nativeTiming.serviceTbt.meanMs, 20);
    assert.equal(report.nativeTiming.serviceTtft.meanMs, 500);
    assert.equal(report.nativeTiming.approximateTpsFromServiceTbt, 50);
    assert.equal(report.perRequestJoinable, false);
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
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
