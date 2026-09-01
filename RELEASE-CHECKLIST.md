# Release checklist

This repository is release-ready only when every required item below is proven by current evidence.

## Product contract

- [x] The automatic line calls the measured value request throughput, not pure generation TPS.
- [x] TTFT comes from Codex `task_complete.time_to_first_token_ms` and is backfilled asynchronously.
- [x] Unattributed OTel TBT is labeled as a capture reference or isolated single-turn candidate,
      always marked unjoined to the current turn.
- [x] Native OTel capture remains explicit opt-in; production Hooks never start the receiver or
      modify the user's exporter configuration.
- [x] Hook failures degrade without steering or extending the model turn.

## Runtime evidence

- [x] A clean interactive Codex CLI session loads both Stop Hook handlers.
- [x] The synchronous handler emits strict JSON and displays throughput.
- [x] The background handler automatically persists TTFT after `task_complete` appears.
- [x] The next automatic line displays the previous turn's TTFT.
- [x] Installed-cache execution through a Windows directory junction is covered by regression tests.
- [x] Removed version caches degrade to strict empty JSON instead of a failed Hook.
- [x] A normal Stop seeds a bounded stable runtime, and display plus TTFT backfill work through it.
- [x] A later synchronous Stop recovers the previous turn's TTFT if asynchronous backfill was missed.
- [x] The local receiver is loopback-only, directory-exclusive, atomically written, and bounded by
      body, payload-count, and total-byte limits.
- [x] Controlled single-request, multi-request, concurrent-session, flush, transport-signal, and
      subagent experiments exercise the documented OTel degradation boundaries.

## Distribution

- [x] The repository contains `.agents/plugins/marketplace.json`.
- [x] The plugin is located at `plugins/codex-tps-plus` and has a valid manifest.
- [x] Public install and upgrade commands are documented in README.
- [x] A clean temporary `CODEX_HOME` installs and enables `codex-tps-plus@kdb-wind` version 0.5.0
      directly from the public `v0.5.0` Git ref.
- [x] Manifest, root package, and plugin package use the same release version.
- [x] The release manifest contains no local cachebuster suffix.

## Quality and safety

- [x] The full OS/Node test matrix is green in GitHub Actions.
- [x] Local unit, Hook contract, privacy, retention, and marketplace release checks pass.
- [x] No raw transcript, OTLP body, credential, review note, or local absolute path is tracked.
- [x] OTel reports expose only allowlisted structure and numbers; raw `.bin` files remain explicitly
      documented as potentially sensitive.
- [x] MIT license notices exist at repository and plugin-package level.
- [x] Security reporting guidance is present.

## Publishing boundary

- [x] Commit history uses the selected GitHub noreply identity.
- [x] The local release candidate is tagged `v0.5.0` at the reviewed commit.
- [x] The public repository exists and contains the published `v0.4.0` release.
- [x] The `v0.5.0` tag and GitHub Release are published from `main`.

## Published v0.5.0 evidence

- The reviewed `v0.5.0` tag points to `bea3497e5022eb018ee63fa338cd7e7b3ec8ede6`.
- The [tag matrix](https://github.com/KDB-Wind/codex-tps-plus/actions/runs/33458712669) and
  [initial main matrix](https://github.com/KDB-Wind/codex-tps-plus/actions/runs/33458712814) passed
  on Windows, macOS, and Linux with Node.js 22 and 24.
- The [v0.5.0 GitHub Release](https://github.com/KDB-Wind/codex-tps-plus/releases/tag/v0.5.0)
  is public and is neither a draft nor a prerelease.
- A clean public-marketplace smoke test installed version 0.5.0, reported it enabled, validated
  the installed plugin structure, and returned strict `{}` JSON from the installed Stop collector.
