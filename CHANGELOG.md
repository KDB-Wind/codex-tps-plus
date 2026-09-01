# Changelog

## 0.5.0 - Unreleased

- Promote the explicit localhost OTLP receiver to `otel.mjs serve`, with an exclusive directory
  lock, bounded raw-capture retention, and receiver identity metadata.
- Preserve native service/iapi TBT and TTFT histogram window, count, sum, min, and max values.
- Distinguish capture aggregates from strict isolated single-turn candidates; neither is presented
  as current-turn or exact per-request TPS without a validated join identifier.
- Add doctor checks for the live receiver, matching loopback logs/metrics exporters, and concurrent
  conversation contamination.
- Record whether TTFT came from direct async backfill or synchronous previous-turn recovery.
- Prevent older same-version local cachebusters from rolling back the stable Hook runtime.
- Document controlled single-request, multi-request, concurrent, flush, transport, and subagent
  experiments on Codex CLI 0.149.1.

## 0.4.0 - 2026-08-31

- Add delayed native TTFT backfill from `task_complete.time_to_first_token_ms`.
- Keep the automatic Stop display non-blocking with an official asynchronous Hook.
- Label native OTel TBT conversion as an unattributed session reference, never current-turn TPS.
- Fix direct Hook execution through Windows directory junctions used by installed plugin caches.
- Ignore unread bytes when a live transcript is truncated between file sizing and reading.
- Keep an already-written status usable when retention cleanup encounters a filesystem race.
- Show `tok/s` consistently on the safe whole-turn fallback line.
- Add a bounded, version-independent Hook runtime under `PLUGIN_DATA` so plugin upgrades do not
  leave resumed sessions calling deleted cache paths.
- Let the synchronous Stop handler recover the previous turn's TTFT when the asynchronous backfill
  was not loaded or did not run.
- Publish a standard Git marketplace layout and cross-platform Node.js test matrix.

Earlier development builds were local-only and were not published as GitHub releases.
