// This is a feasibility model, not the production collector. Pure-generation
// candidates use total decoded output once. The default product metric instead
// uses non-reasoning output over end-to-end duration.

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function outputTokensForRate(usage) {
  return Math.max(0, numberOrNull(usage?.output_tokens ?? usage?.outputTokens) ?? 0);
}

export function nonReasoningOutputTokensForRate(usage) {
  const outputTokens = numberOrNull(usage?.output_tokens ?? usage?.outputTokens);
  const reasoningTokens = numberOrNull(
    usage?.reasoning_output_tokens ?? usage?.reasoningOutputTokens
  );
  if (
    outputTokens === null ||
    outputTokens < 0 ||
    reasoningTokens === null ||
    reasoningTokens < 0 ||
    reasoningTokens > outputTokens
  ) {
    return null;
  }
  return outputTokens - reasoningTokens;
}

export function endToEndMs(sample) {
  const completed = numberOrNull(sample?.completedDurationMs ?? sample?.completed_duration_ms);
  if (completed !== null && completed > 0) return completed;
  const direct = numberOrNull(sample?.duration_ms ?? sample?.durationMs);
  if (direct !== null && direct > 0) return direct;
  const started = numberOrNull(sample?.started_at ?? sample?.startedAt);
  const finished = numberOrNull(sample?.completed_at ?? sample?.completedAt);
  if (started === null || finished === null || finished <= started) return null;
  return (finished - started) * 1000;
}

export function endToEndRate(sample) {
  const tokens = nonReasoningOutputTokensForRate(sample);
  const durationMs = endToEndMs(sample);
  return tokens !== null && tokens > 0 && durationMs !== null
    ? tokens / (durationMs / 1000)
    : null;
}

export function weightedEndToEndRate(samples) {
  let tokens = 0;
  let durationMs = 0;
  for (const sample of samples || []) {
    const count = nonReasoningOutputTokensForRate(sample);
    const duration = endToEndMs(sample);
    if (count === null || count <= 0 || duration === null) continue;
    tokens += count;
    durationMs += duration;
  }
  return tokens > 0 && durationMs > 0 ? tokens / (durationMs / 1000) : null;
}

export function pureGenerationMs(sample) {
  const direct = numberOrNull(sample?.generation_ms ?? sample?.generationMs);
  if (direct !== null) return direct > 0 ? direct : null;
  const first = numberOrNull(sample?.first_token_at ?? sample?.firstTokenAt);
  const completed = numberOrNull(sample?.completed_at ?? sample?.completedAt);
  if (first === null || completed === null || completed <= first) return null;
  return (completed - first) * 1000;
}

export function requestRate(sample) {
  const tokens = outputTokensForRate(sample);
  const duration = pureGenerationMs(sample);
  return tokens > 0 && duration !== null ? tokens / (duration / 1000) : null;
}

export function weightedRate(samples) {
  let tokens = 0;
  let durationMs = 0;
  for (const sample of samples || []) {
    const count = outputTokensForRate(sample);
    const duration = pureGenerationMs(sample);
    if (count <= 0 || duration === null) continue;
    tokens += count;
    durationMs += duration;
  }
  return tokens > 0 && durationMs > 0 ? tokens / (durationMs / 1000) : null;
}

export function classifyTpsEvidence({ hasOutputTokens, hasPureGenerationDuration, hasEndToEndDuration }) {
  if (hasOutputTokens && hasPureGenerationDuration) return "tps_candidate";
  if (hasOutputTokens && hasEndToEndDuration) return "throughput_only";
  return "unavailable";
}
