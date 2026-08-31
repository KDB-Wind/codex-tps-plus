# Release checklist

This repository is release-ready only when every required item below is proven by current evidence.

## Product contract

- [x] The automatic line calls the measured value request throughput, not pure generation TPS.
- [x] TTFT comes from Codex `task_complete.time_to_first_token_ms` and is backfilled asynchronously.
- [x] Unattributed OTel TBT is labeled as a session reference and never attached to the current turn.
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

## Distribution

- [x] The repository contains `.agents/plugins/marketplace.json`.
- [x] The plugin is located at `plugins/codex-tps-plus` and has a valid manifest.
- [x] Public install and upgrade commands are documented in README.
- [x] Manifest, root package, and plugin package use the same release version.
- [x] The release manifest contains no local cachebuster suffix.

## Quality and safety

- [ ] The full OS/Node test matrix is green in GitHub Actions.
- [x] Local unit, Hook contract, privacy, retention, and marketplace release checks pass.
- [x] No raw transcript, OTLP body, credential, review note, or local absolute path is tracked.
- [x] MIT license notices exist at repository and plugin-package level.
- [x] Security reporting guidance is present.

## Publishing boundary

- [x] Commit history uses the selected GitHub noreply identity.
- [x] The local release candidate is tagged `v0.4.0`.
- [ ] The public repository and GitHub Release exist.

External repository creation, push, and GitHub Release publication remain intentionally unchecked until
the repository owner authorizes them. The GitHub Actions item can only be proven after that push; local
parity is checked by `npm test` and `npm run release:check` before authorization.
