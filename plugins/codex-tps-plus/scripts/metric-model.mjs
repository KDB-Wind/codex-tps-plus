// This is a feasibility model, not the final collector.
// Codex's reasoning_output_tokens is a subset of output_tokens. The rate
// numerator must therefore use output_tokens exactly once.

function numberOrNull(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function outputTokensForRate(usage) {
  return Math.max(0, numberOrNull(usage?.output_tokens ?? usage?.outputTokens) ?? 0);
}

export function pureGenerationMs(sample) {
  const direct = numberOrNull(sample?.generation_ms ?? sample?.generationMs);
  if (direct !== null) return direct > 0 ? direct : null;
  const first = numberOrNull(sample?.first_token_at ?? sample?.firstTokenAt);
  const completed = numberOrNull(sample?.completed_at ?? sample?.completedAt);
  if (first === null || completed === null || completed <= first) return null;
  return completed - first;
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
