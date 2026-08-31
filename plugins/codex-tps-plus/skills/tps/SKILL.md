---
name: tps
description: Show delayed Codex CLI TTFT, request throughput including TTFT, weighted session values, and end-to-end turn throughput.
---

Run the bundled `../../scripts/status.mjs --json`, resolving the path relative to this
`SKILL.md`. Report the returned values directly and concisely. If the script reports
no data, tell the user to complete one turn in a new Codex CLI session with the plugin
hook trusted.

The automatic Stop line and this command expose two related values:

- `请求内吞吐（含首字）`: output tokens divided by inferred model-request intervals. The
  intervals run from turn/request start to the last persisted model response item,
  excluding tool execution between requests but including TTFT.
- `整轮吞吐`: `sum(output_tokens) / sum(turn wall-clock seconds)`.
- `TTFT`: the turn-level `task_complete.time_to_first_token_ms` value. Codex writes
  `task_complete` after synchronous Stop hooks, so a background Stop handler backfills it. The
  first automatic line cannot contain its own TTFT; the next line may say `上轮 TTFT`, while this
  command can show the latest value after the backfill completes. If that background handler did not
  run, the next synchronous Stop also recovers the previous turn's completed TTFT.

The session TTFT mean is the arithmetic mean across turns with a successfully backfilled TTFT. It
is not token-weighted. Do not treat a missing TTFT as zero.

Do not call request throughput TPS. It includes TTFT and depends on unstable transcript
event ordering, so it is not exact pure-generation TPS. `短回复参考` means the latest
turn averaged fewer than 128 output tokens per inferred request; this is a display
warning because TTFT can dominate short responses, not a correction to the value.
Only report request throughput when `requestCoverageComplete` is true. If any output-bearing
request interval is unestimated, explain that the plugin deliberately falls back to whole-turn
throughput rather than presenting a partial request sample as the whole turn.
Turn throughput can additionally include tools and waiting. `reasoning_output_tokens`
is already a subset of `output_tokens` and must not be added again.

When the user asks about native OTel, explain that Codex service TBT can be converted
with `1000 / TBT_ms`, but OTLP metrics are batch-exported and carry no request/turn ID
in the verified capture, so the Stop hook cannot safely attach them to the current turn. If
`nativeOtel` is present, label it as an unattributed capture/session reference, never current-turn
or exact per-request TPS.
