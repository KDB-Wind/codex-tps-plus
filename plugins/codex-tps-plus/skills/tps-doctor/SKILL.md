---
name: tps-doctor
description: Diagnose the Codex TPS Plus request-throughput hook and optional native OTel probes without exposing conversation content.
---

Run the bundled `../../scripts/doctor.mjs --json`, resolving the path relative to this
`SKILL.md`, for local prerequisites. Use `../../scripts/status.mjs --json` to verify
whether the current session has recorded throughput data.

The release configuration has one `Stop` event with two handlers: a synchronous display collector
and an official background (`async: true`) TTFT backfill. A missing current-turn TTFT immediately
after Stop is expected; check again after the transcript receives `task_complete`. The next
synchronous Stop also recovers the previous turn's TTFT if the asynchronous handler was not loaded
or did not run.

For a transcript supplied by a hook, run `node scripts/analyze-transcript.mjs <transcript.jsonl>`.
The output is a redacted structural summary: paths, prompt bodies, assistant text, commands,
and full identifiers are not emitted.

For a local OTLP HTTP capture, start the explicit receiver with
`node scripts/otel.mjs serve --output-dir <capture-directory> --port <port>`, then run
`node scripts/doctor.mjs --otel-capture <capture-directory> --json` and
`node scripts/otel.mjs scan <capture-directory>`.
The scanner structurally decodes OTLP protobuf. It reports `1000 / service TBT` as a
native approximate TPS candidate while keeping request/turn joinability separate.
An existing capture can be attached to status output with
`node scripts/status.mjs --otel-capture <capture-directory> --json`; this remains an unattributed
capture aggregate or strict isolated-window candidate unless a validated request/turn join key is
present. Receiver exclusivity and conversation isolation are separate checks. A single-turn
candidate is still not current-turn attribution or exact per-request TPS.

Treat every captured OTLP `.bin` as raw, potentially sensitive data. The safe inspector output is
not proof that the underlying body is redacted. Keep capture opt-in and delete the exact temporary
capture directory after the experiment.
