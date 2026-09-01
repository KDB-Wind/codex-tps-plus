import fs from "node:fs";

export const E2_STATIC_FIELDS = Object.freeze([
  "outputTokens",
  "reasoningTokens",
  "requestDurationMs",
  "estimatedOutputTokens",
  "estimatedRequestCount",
  "unestimatedRequestCount",
  "tokenCountEvents",
  "duplicateTokenCountEvents",
  "toolCallCount",
]);

const TOOL_ITEM_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "mcp_tool_call",
]);

const MODEL_ACTIVITY_ITEM_TYPES = new Set([
  ...TOOL_ITEM_TYPES,
  "web_search_call",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(record, fallbackSeconds = null) {
  const fromRecord = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (Number.isFinite(fromRecord)) return fromRecord;
  const seconds = numberOrNull(fallbackSeconds);
  return seconds === null ? null : seconds * 1000;
}

function usageFrom(payload) {
  const last = payload?.info?.last_token_usage;
  if (!isObject(last)) return null;
  const outputTokens = numberOrNull(last.output_tokens);
  if (outputTokens === null || outputTokens < 0) return null;
  const reasoningRaw = numberOrNull(last.reasoning_output_tokens);
  const totalOutputTokens = numberOrNull(payload?.info?.total_token_usage?.output_tokens);
  return {
    outputTokens,
    reasoningTokens: reasoningRaw !== null && reasoningRaw >= 0 ? reasoningRaw : null,
    totalOutputTokens: totalOutputTokens !== null && totalOutputTokens >= 0 ? totalOutputTokens : null,
  };
}

function parseRecords(source) {
  if (Array.isArray(source)) return { records: source, parseErrorCount: 0 };
  if (typeof source !== "string" || !source) return { records: [], parseErrorCount: 0 };
  let text;
  try {
    text = fs.readFileSync(source, "utf8");
  } catch {
    return { records: [], parseErrorCount: 1 };
  }
  const records = [];
  let parseErrorCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      parseErrorCount += 1;
    }
  }
  return { records, parseErrorCount };
}

function emptyReference(parseErrorCount = 0) {
  return {
    available: false,
    reason: "turn_not_found",
    startedAtMs: null,
    completedAtMs: null,
    durationMs: null,
    parseErrorCount,
    staticFields: {
      outputTokens: 0,
      reasoningTokens: 0,
      requestDurationMs: null,
      estimatedOutputTokens: 0,
      estimatedRequestCount: 0,
      unestimatedRequestCount: 0,
      tokenCountEvents: 0,
      duplicateTokenCountEvents: 0,
      toolCallCount: 0,
    },
  };
}

/**
 * Recomputes the v0.5 transcript fields for E2 from a small immutable input.
 * This parser intentionally has no dependency on the production status code.
 */
export function computeE2Reference(source, turnId, options = {}) {
  if (typeof turnId !== "string" || !turnId) return emptyReference(0);
  const parsed = parseRecords(source);
  let activeTurnId = null;
  let startedAtMs = null;
  let completedAtMs = null;
  let found = false;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reasoningKnown = true;
  let requestDurationMs = 0;
  let estimatedOutputTokens = 0;
  let estimatedRequestCount = 0;
  let unestimatedRequestCount = 0;
  let tokenCountEvents = 0;
  let duplicateTokenCountEvents = 0;
  let toolCallCount = 0;
  let requestStartAtMs = null;
  let latestModelActivityAtMs = null;
  const seenCumulativeOutput = new Set();
  const seenFallbackUsage = new Set();
  const maxDurationMs = Number.isFinite(options.maxDurationMs) && options.maxDurationMs > 0
    ? options.maxDurationMs
    : 24 * 60 * 60 * 1000;

  for (const record of parsed.records) {
    const payload = isObject(record?.payload) ? record.payload : null;
    if (!payload) continue;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
      if (activeTurnId === turnId) {
        found = true;
        startedAtMs = timestampMs(record, payload.started_at);
        completedAtMs = null;
        outputTokens = 0;
        reasoningTokens = 0;
        reasoningKnown = true;
        requestDurationMs = 0;
        estimatedOutputTokens = 0;
        estimatedRequestCount = 0;
        unestimatedRequestCount = 0;
        tokenCountEvents = 0;
        duplicateTokenCountEvents = 0;
        toolCallCount = 0;
        requestStartAtMs = startedAtMs;
        latestModelActivityAtMs = null;
        seenCumulativeOutput.clear();
        seenFallbackUsage.clear();
      }
      continue;
    }
    if (payload.type === "task_complete") {
      const completedTurnId = typeof payload.turn_id === "string" && payload.turn_id
        ? payload.turn_id
        : activeTurnId;
      if (completedTurnId === turnId && activeTurnId === turnId) {
        completedAtMs = timestampMs(record, payload.completed_at);
        activeTurnId = null;
        continue;
      }
      if (completedTurnId === activeTurnId) activeTurnId = null;
      continue;
    }
    if (!found || activeTurnId !== turnId) continue;

    if (record.type === "response_item") {
      const itemType = typeof payload.type === "string" ? payload.type : null;
      const assistantMessage = itemType === "message" && payload.role === "assistant";
      if (assistantMessage || itemType === "reasoning" || MODEL_ACTIVITY_ITEM_TYPES.has(itemType)) {
        const activityAtMs = timestampMs(record);
        if (activityAtMs !== null) latestModelActivityAtMs = activityAtMs;
      }
      if (TOOL_ITEM_TYPES.has(itemType)) toolCallCount += 1;
    }
    if (payload.type !== "token_count") continue;
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
    const tokenAtMs = timestampMs(record);
    const responseEndAtMs = latestModelActivityAtMs ?? tokenAtMs;
    if (
      usage.outputTokens > 0 &&
      requestStartAtMs !== null &&
      responseEndAtMs !== null &&
      responseEndAtMs > requestStartAtMs
    ) {
      const intervalMs = responseEndAtMs - requestStartAtMs;
      if (intervalMs <= maxDurationMs) {
        requestDurationMs += intervalMs;
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
    if (tokenAtMs !== null) requestStartAtMs = tokenAtMs;
    latestModelActivityAtMs = null;
  }

  if (!found) return emptyReference(parsed.parseErrorCount);
  const capturedAtMs = numberOrNull(options.nowMs);
  const durationMs = capturedAtMs !== null && startedAtMs !== null
    ? capturedAtMs - startedAtMs
    : null;
  return {
    available: true,
    reason: completedAtMs === null ? "turn_not_complete" : null,
    startedAtMs,
    completedAtMs,
    durationMs,
    parseErrorCount: parsed.parseErrorCount,
    staticFields: {
      outputTokens,
      reasoningTokens: reasoningKnown ? reasoningTokens : null,
      requestDurationMs: requestDurationMs || null,
      estimatedOutputTokens,
      estimatedRequestCount,
      unestimatedRequestCount,
      tokenCountEvents,
      duplicateTokenCountEvents,
      toolCallCount,
    },
  };
}

function actualMetric(record) {
  return isObject(record?.metric) ? record.metric : record;
}

export function compareE2StaticFields(record, reference) {
  const actual = actualMetric(record);
  const fields = {};
  for (const field of E2_STATIC_FIELDS) {
    const expected = reference?.staticFields?.[field] ?? null;
    const observed = actual?.[field] ?? null;
    fields[field] = {
      expected,
      observed,
      equal: Object.is(expected, observed),
    };
  }
  return {
    available: Boolean(reference?.available),
    allEqual: Boolean(reference?.available) && E2_STATIC_FIELDS.every((field) => fields[field].equal),
    fields,
  };
}

export function compareE2Duration(record, reference) {
  const actual = actualMetric(record);
  const capturedAtMs = Date.parse(record?.capturedAt || record?.captured_at || "");
  const expected = Number.isFinite(capturedAtMs) && reference?.startedAtMs !== null
    ? capturedAtMs - reference.startedAtMs
    : null;
  const observed = numberOrNull(actual?.durationMs);
  return {
    available: expected !== null,
    expected,
    observed,
    equal: expected !== null && observed === expected,
    timeAnchor: "record.capturedAt",
  };
}

export function compareE2BackfilledTiming(record, expected) {
  const actual = actualMetric(record);
  const expectedSource = typeof expected?.timingSource === "string" ? expected.timingSource : null;
  const observedSource = typeof actual?.timingSource === "string" ? actual.timingSource : null;
  const hasExpected = isObject(expected) &&
    numberOrNull(expected.ttftMs) !== null &&
    numberOrNull(expected.completedDurationMs) !== null &&
    expectedSource !== null;
  const hasObserved = numberOrNull(actual?.ttftMs) !== null &&
    numberOrNull(actual?.completedDurationMs) !== null &&
    observedSource !== null;
  return {
    available: hasExpected && hasObserved,
    equal: hasExpected && hasObserved &&
      actual.ttftMs === expected.ttftMs &&
      actual.completedDurationMs === expected.completedDurationMs &&
      observedSource === expectedSource,
    expected: hasExpected
      ? {
          ttftMs: expected.ttftMs,
          completedDurationMs: expected.completedDurationMs,
          timingSource: expectedSource,
        }
      : null,
    observed: hasObserved
      ? {
          ttftMs: actual.ttftMs,
          completedDurationMs: actual.completedDurationMs,
          timingSource: observedSource,
        }
      : null,
  };
}

function sortedNumbers(values) {
  return (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function describeDistribution(values) {
  const sorted = sortedNumbers(values);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  return {
    n: sorted.length,
    q1,
    median,
    q3,
    iqr: q1 === null || q3 === null ? null : q3 - q1,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

export function randomInterleave(enabled, disabled, random = Math.random) {
  const entries = [
    ...(enabled || []).map((value) => ({ sample: value, observer: "enabled" })),
    ...(disabled || []).map((value) => ({ sample: value, observer: "disabled" })),
  ];
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const candidate = Number(random());
    const normalized = Number.isFinite(candidate) && candidate >= 0 && candidate < 1 ? candidate : 0;
    const swap = Math.floor(normalized * (index + 1));
    [entries[index], entries[swap]] = [entries[swap], entries[index]];
  }
  return entries;
}

export function analyzePerformanceSamples(enabled, disabled, options = {}) {
  const enabledStats = describeDistribution(enabled);
  const disabledStats = describeDistribution(disabled);
  const denominator = enabledStats.iqr !== null && disabledStats.iqr !== null
    ? (enabledStats.iqr + disabledStats.iqr) / 2
    : null;
  const effectSize = enabledStats.median === null || disabledStats.median === null
    ? null
    : denominator && denominator > 0
      ? (enabledStats.median - disabledStats.median) / denominator
      : enabledStats.median === disabledStats.median ? 0 : null;
  return {
    randomOrder: randomInterleave(enabled, disabled, options.random),
    enabled: enabledStats,
    disabled: disabledStats,
    effectSize: {
      name: "iqr_normalized_median_difference",
      value: effectSize,
      threshold: null,
    },
    conclusion: "distribution_observation_only",
  };
}

export function assessProtocolInvariants(runs) {
  const values = (runs || []).filter(isObject);
  const selected = values.map((run) => run.discovery?.selectedThreadId).filter(Boolean);
  const sameThread = selected.length <= 1 || selected.every((id) => id === selected[0]);
  const hasRuns = values.length > 0;
  return {
    threadIdStable: hasRuns && sameThread && values.every((run) => run.protocolInvariants?.threadIdStable === true),
    noExtraTurn: hasRuns && values.every((run) => run.protocolInvariants?.extraTurnCount === 0),
    noFork: hasRuns && values.every((run) => run.protocolInvariants?.noForkObserved === true),
    noReplay: hasRuns && values.every((run) => run.protocolInvariants?.noReplayObserved === true),
    tuiNormal: null,
    unsubscribeClean: hasRuns && values.every((run) => run.unsubscribe?.ok === true),
    evidence: "deterministic_protocol_fields_only",
  };
}
