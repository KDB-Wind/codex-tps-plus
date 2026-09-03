---
name: tps-doctor
description: Diagnose Codex TPS Plus end-to-end throughput, delayed timing backfill, and optional native OTel probes without exposing conversation content.
---

Run the bundled `../../scripts/doctor.mjs --json`, resolving the path relative to this
`SKILL.md`, for local prerequisites. Use `../../scripts/status.mjs --json` to verify whether the
current session has recorded throughput data.

The release configuration has one `Stop` event with two handlers: a synchronous display collector
and an official background (`async: true`) completion-timing backfill. The current automatic line
uses a provisional Stop wall clock. After `task_complete` appears, the background handler makes a
valid `duration_ms` authoritative and separately records a valid TTFT. Missing TTFT must not block
duration correction; missing duration must not turn TTFT into zero. A later synchronous Stop also
recovers the previous turn when the background handler did not run.

For a transcript supplied by a Hook, run `node scripts/analyze-transcript.mjs <transcript.jsonl>`.
The output is a redacted structural summary: paths, prompts, assistant text, commands, and full
identifiers are not emitted.

For a local OTLP HTTP capture, start the explicit receiver with
`node scripts/otel.mjs serve --output-dir <capture-directory> --port <port>`, then run
`node scripts/doctor.mjs --otel-capture <capture-directory> --json` and
`node scripts/otel.mjs scan <capture-directory>`. An existing capture can be attached with
`node scripts/status.mjs --otel-capture <capture-directory> --json`.

The OTel TBT reciprocal remains an unattributed capture aggregate or isolated-window candidate
unless a validated request/turn join key exists. Receiver exclusivity and conversation isolation
are separate checks. Treat every captured `.bin` as raw, potentially sensitive data; delete the
exact temporary capture directory after the experiment.
