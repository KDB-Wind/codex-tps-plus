---
name: tps
description: Show Codex CLI non-reasoning end-to-end throughput, delayed completion timing and TTFT, weighted session values, and optional diagnostic references.
---

Run the bundled `../../scripts/status.mjs --json`, resolving the path relative to this
`SKILL.md`. Report the returned values directly and concisely. If no data is available, tell the
user to complete one turn in a new Codex CLI session with the plugin Hook trusted.

Lead with `latest.nonReasoningThroughput` and `session.nonReasoningThroughput`. Their numerator is
`output_tokens - reasoning_output_tokens`; their denominator is end-to-end turn time, so call them
non-reasoning output throughput, never pure-generation TPS. Mention that non-reasoning output can
include generated tool-call arguments when that distinction matters.

Report `latest.durationSource` with the timing:

- `task_complete` is the delayed authoritative `task_complete.duration_ms` value.
- `stop_wall_clock` is the provisional synchronous Stop measurement used until completion backfill.

Show total output, reasoning, and non-reasoning counts without adding reasoning again. If
`reasoningBreakdownAvailable` is false, report the explicitly labeled `totalOutputThroughput`
fallback; do not infer or mix a non-reasoning session average from that record.

TTFT comes from `task_complete.time_to_first_token_ms`. Completion duration and TTFT are validated
and backfilled independently, so either may be available without the other. The first automatic
line cannot contain its own TTFT; a later query can, and the next line may label it `最近有效 TTFT`.
The session TTFT mean is arithmetic across turns with a valid TTFT, not token-weighted.

Only discuss `requestThroughput` when the user asks for diagnostics. It uses non-reasoning output
over transcript-inferred request intervals, includes TTFT, depends on unstable event ordering, and
is not an exact request rate or generation TPS. Require `requestCoverageComplete` and identify it as
a heuristic reference. `requestIntervalTotalOutputThroughput` is the corresponding legacy-style
total-output comparison.

For native OTel, report `confidence` exactly. `capture-aggregate` is a capture reference;
`isolated-window-candidate` is still unattributed to the live Stop. Neither is current-turn or exact
per-request TPS. Mention `shortOutputReference` when true.
