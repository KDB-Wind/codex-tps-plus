#!/usr/bin/env node

// Privacy-preserving structural inspection of local OTLP protobuf captures.
// Arbitrary attribute values, log bodies, IDs, prompts, and tool data are never
// included in the returned report.

import fs from "node:fs";
import path from "node:path";
import { isDirectRun } from "./direct-run.mjs";
import { decodeLogsRequest, decodeMetricsRequest } from "./otlp-protobuf.mjs";

const SIGNAL_FRAGMENTS = [
  "responses_api_engine_service_tbt",
  "responses_api_engine_service_ttft",
  "responses_api_engine_iapi_tbt",
  "responses_api_engine_iapi_ttft",
  "turn.ttft.duration_ms",
  "turn.token_usage",
  "turn.e2e_duration_ms",
  "codex.api_request",
  "codex.sse_event",
  "response.completed",
];

const ID_KEY = /(?:^|[._-])(conversation|session|request|turn)(?:[._-])?(?:id|uuid)$/i;
const REQUEST_KEY = /(?:^|[._-])(request|turn)(?:[._-])?(?:id|uuid)$/i;
const SESSION_KEY = /(?:^|[._-])(conversation|session)(?:[._-])?(?:id|uuid)$/i;
const TEMPORALITY = { 0: "unspecified", 1: "delta", 2: "cumulative" };
const SAFE_TOKEN_TYPES = new Set([
  "input",
  "output",
  "reasoning",
  "cached_input",
  "cache_write_input",
  "tool",
]);
const SAFE_UNITS = new Set(["1", "ms", "s", "By"]);
const SAFE_ENDPOINTS = new Set(["/v1/logs", "/v1/metrics", "/v1/traces"]);

function safeEndpoint(value) {
  try {
    const pathname = new URL(String(value || ""), "http://127.0.0.1").pathname;
    return SAFE_ENDPOINTS.has(pathname) ? pathname : "unknown";
  } catch {
    return "unknown";
  }
}

function safeBodyPath(directory, bodyName) {
  if (typeof bodyName !== "string" || path.basename(bodyName) !== bodyName || !bodyName.endsWith(".bin")) {
    return null;
  }
  return path.join(directory, bodyName);
}

function signalFor(value) {
  if (typeof value !== "string") return null;
  return SIGNAL_FRAGMENTS.find((fragment) => value.includes(fragment)) || null;
}

function collectKeyNames(target, attributes) {
  for (const key of Object.keys(attributes || {})) target.add(key);
}

function safeMetric(metric, resourceIndex) {
  const signal = signalFor(metric.name);
  if (!signal) return null;
  const attributeKeys = new Set();
  const points = metric.points.map((point) => {
    collectKeyNames(attributeKeys, point.attributes);
    const result = {
      attributeKeys: Object.keys(point.attributes || {}).sort(),
      startTime: point.startTime,
      time: point.time,
    };
    if (SAFE_TOKEN_TYPES.has(point.attributes?.token_type)) {
      result.tokenType = point.attributes.token_type;
    }
    if (metric.type === "histogram") {
      Object.assign(result, { count: point.count, sum: point.sum, min: point.min, max: point.max });
    } else {
      result.value = point.value;
    }
    return result;
  });
  return {
    resourceIndex,
    name: signal,
    signal,
    type: metric.type,
    unit: SAFE_UNITS.has(metric.unit) ? metric.unit : null,
    temporality: metric.temporality == null ? null : TEMPORALITY[metric.temporality] || `unknown-${metric.temporality}`,
    pointAttributeKeys: [...attributeKeys].sort(),
    points,
  };
}

function safeLogSignal(record) {
  const candidates = [record.body, ...Object.values(record.attributes || {})];
  for (const candidate of candidates) {
    const signal = signalFor(candidate);
    if (signal) return signal;
  }
  return null;
}

function safeLogRecord(record) {
  const signal = safeLogSignal(record);
  if (!signal) return null;
  const numericNames = [
    "duration_ms",
    "ttft_ms",
    "input_token_count",
    "output_token_count",
    "reasoning_token_count",
    "cached_token_count",
    "cache_write_token_count",
    "tool_token_count",
    "http.response.status_code",
  ];
  const numericAttributes = {};
  for (const name of numericNames) {
    const raw = record.attributes?.[name];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (Number.isFinite(value)) numericAttributes[name] = value;
  }
  return {
    signal,
    time: record.time || record.observedTime,
    attributeKeys: Object.keys(record.attributes || {}).sort(),
    numericAttributes,
  };
}

function structuralInspection(directory, entries) {
  const metricResourceKeys = new Set();
  const metricPointKeys = new Set();
  const logResourceKeys = new Set();
  const logRecordKeys = new Set();
  const signals = new Set();
  const metrics = [];
  const logEvents = [];
  const parseErrors = [];
  let decodedMetricPayloads = 0;
  let decodedLogPayloads = 0;
  let logRecords = 0;

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const bodyPath = safeBodyPath(directory, entry.metadata.bodyFile);
    if (!bodyPath || !fs.existsSync(bodyPath)) continue;
    try {
      const body = fs.readFileSync(bodyPath);
      if (entry.url.endsWith("/metrics")) {
        const decoded = decodeMetricsRequest(body);
        decodedMetricPayloads += 1;
        decoded.resources.forEach((resource, resourceIndex) => {
          collectKeyNames(metricResourceKeys, resource.resource);
          for (const scope of resource.scopes) {
            for (const metric of scope.metrics) {
              for (const point of metric.points) collectKeyNames(metricPointKeys, point.attributes);
              const safe = safeMetric(metric, resourceIndex);
              if (safe) {
                metrics.push(safe);
                signals.add(safe.signal);
              }
            }
          }
        });
      } else if (entry.url.endsWith("/logs")) {
        const decoded = decodeLogsRequest(body);
        decodedLogPayloads += 1;
        for (const resource of decoded.resources) {
          collectKeyNames(logResourceKeys, resource.resource);
          for (const scope of resource.scopes) {
            for (const record of scope.records) {
              logRecords += 1;
              collectKeyNames(logRecordKeys, record.attributes);
              const safe = safeLogRecord(record);
              if (safe) {
                signals.add(safe.signal);
                logEvents.push(safe);
              }
            }
          }
        }
      }
    } catch {
      parseErrors.push({
        payloadIndex: entryIndex,
        kind: entry.url.endsWith("/metrics") ? "metrics" : "logs",
      });
    }
  }

  const metricKeys = new Set([...metricResourceKeys, ...metricPointKeys]);
  const logKeys = new Set([...logResourceKeys, ...logRecordKeys]);
  const sharedKeys = [...metricKeys].filter((key) => logKeys.has(key)).sort();
  const metricIdKeys = [...metricKeys].filter((key) => ID_KEY.test(key)).sort();
  const sharedRequestKeys = sharedKeys.filter((key) => REQUEST_KEY.test(key));
  const sessionKeys = [...new Set([...metricKeys, ...logKeys])].filter((key) => SESSION_KEY.test(key)).sort();

  return {
    decodedMetricPayloads,
    decodedLogPayloads,
    logRecords,
    parseErrors,
    signals: [...signals].sort(),
    metricResourceAttributeKeys: [...metricResourceKeys].sort(),
    metricPointAttributeKeys: [...metricPointKeys].sort(),
    logResourceAttributeKeys: [...logResourceKeys].sort(),
    logRecordAttributeKeys: [...logRecordKeys].sort(),
    sharedMetricLogAttributeKeys: sharedKeys,
    metricIdAttributeKeys: metricIdKeys,
    sessionKeyNames: sessionKeys,
    requestKeyNames: sharedRequestKeys,
    perRequestJoinKeyObserved: sharedRequestKeys.length > 0,
    metrics,
    logEvents,
  };
}

function nativeTimingSummary(metrics) {
  const aggregate = (signal) => {
    let count = 0;
    let sumMs = 0;
    for (const metric of metrics.filter((item) => item.signal === signal)) {
      for (const point of metric.points) {
        const pointCount = Number(point.count);
        const pointSum = Number(point.sum);
        if (Number.isFinite(pointCount) && pointCount > 0 && Number.isFinite(pointSum) && pointSum > 0) {
          count += pointCount;
          sumMs += pointSum;
        }
      }
    }
    return count > 0 ? { observations: count, meanMs: sumMs / count } : null;
  };
  const serviceTbt = aggregate("responses_api_engine_service_tbt");
  const serviceTtft = aggregate("responses_api_engine_service_ttft");
  const iapiTbt = aggregate("responses_api_engine_iapi_tbt");
  const iapiTtft = aggregate("responses_api_engine_iapi_ttft");
  return {
    source: "codex-native-otel-engine-timing",
    serviceTbt,
    serviceTtft,
    iapiTbt,
    iapiTtft,
    approximateTpsFromServiceTbt:
      serviceTbt?.meanMs > 0 ? 1000 / serviceTbt.meanMs : null,
    exactPerRequestTps: false,
    caveat: !serviceTbt
      ? "service-tbt-not-observed"
      : serviceTbt.observations > 1
        ? "reciprocal-of-unweighted-mean-tbt-across-observations"
        : "reciprocal-of-service-tbt-observation",
  };
}

export function inspectOtelCapture(directory) {
  if (!fs.existsSync(directory)) return { directoryPresent: false };
  const metaFiles = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"));
  const entries = [];
  const byUrl = {};
  let metricPayloads = 0;
  let logPayloads = 0;
  for (const entry of metaFiles) {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      const url = safeEndpoint(metadata.url);
      byUrl[url] = (byUrl[url] || 0) + 1;
      if (url.endsWith("/metrics")) metricPayloads += 1;
      if (url.endsWith("/logs")) logPayloads += 1;
      entries.push({
        url,
        metadata: {
          bodyFile: metadata.bodyFile || entry.name.replace(/\.meta\.json$/, ".bin"),
        },
      });
    } catch {}
  }
  const structural = structuralInspection(directory, entries);
  const hasTbt = structural.signals.some((signal) => signal.includes("_tbt"));
  const hasTtft = structural.signals.some((signal) => signal.includes("_ttft") || signal.includes("turn.ttft"));
  const hasTokenUsage = structural.signals.includes("turn.token_usage");
  const hasDirectMetricRequestKey = structural.metricPointAttributeKeys.some((key) => REQUEST_KEY.test(key));
  const perRequestJoinable = hasTbt && hasTtft && hasTokenUsage && hasDirectMetricRequestKey;
  const nativeTiming = nativeTimingSummary(structural.metrics);
  return {
    directoryPresent: true,
    requestCount: metaFiles.length,
    byUrl,
    metricPayloads,
    logPayloads,
    ...structural,
    directMetricRequestKeyObserved: hasDirectMetricRequestKey,
    perRequestJoinable,
    nativeTiming,
    rawCaptureSensitive: true,
    inspectionIsContentRedactionProof: false,
    joinabilityInspection: "structured-otlp-protobuf",
    conclusion: perRequestJoinable
      ? "candidate-per-request-joinable-requires-semantic-validation"
      : hasTbt && hasTtft && hasTokenUsage
        ? "timing-and-token-signals-present-without-direct-request-or-turn-key"
        : "no-joinable-per-request-pure-generation-timing-confirmed",
  };
}

if (isDirectRun(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) {
    console.error("Usage: node scripts/otel-inspect.mjs <capture-directory>");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(inspectOtelCapture(path.resolve(directory)), null, 2));
  }
}
