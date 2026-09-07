# Release checklist

## 0.6.0 candidate boundary

- [x] The repository, plugin package, and plugin manifest identify the candidate `0.6.0`.
- [x] The accuracy contract is frozen in `PLAN-0.6.0.md`.
- [x] Local unit, Hook contract, privacy, retention, doctor, and marketplace release checks pass.
- [x] No `v0.6.0` tag is created.
- [x] Candidate branch CI is allowed; main, release tags, and GitHub Releases remain unchanged during trial.
- [x] Automated installation smoke uses a disposable CODEX_HOME, real Codex CLI 0.153.4, and synthetic Hook inputs.
- [x] Local Windows install, 0.5.0 upgrade, completion backfill, repeated Stop, and removed-cache recovery pass.
- [x] Candidate `cb294b6` passes the Windows/macOS/Linux matrix on Node.js 22 and 24
      ([run 34089731796](https://github.com/KDB-Wind/codex-tps-plus/actions/runs/34089731796));
      rerun this gate for any later code changes.
- [x] The fixed production files are installed locally with a distinct cachebuster, content checked,
      and the stable runtime is activated; doctor reports zero failed checks.
- [ ] Interactive new-session/resumed-session trial passes before promotion to main.

## Check modes and promotion

`npm run release:check` (or `-- --candidate`) validates package structure, consistent unsuffixed
versions, Hook definitions, and tracked-file hygiene. It does not require or forbid a local release
tag, so fetching historical tags cannot break candidate or main CI. It never publishes anything.

`npm run release:verify` performs the same checks and additionally requires a clean checkout and
`v<package.version>` pointing to HEAD. In tag CI, the triggering tag must match the package version.
The workflow fetches full history and runs this mode for tag pushes. Regression tests exercise missing
tags, dirty trees, mismatched tags, and tags pointing to another commit.

After trial approval: merge the validated changes to main, rerun the matrix, tag the intended commit,
and require the tag matrix (including `release:verify`) to pass before publishing a GitHub Release.
No automatic release publication is configured.

`npm run smoke:install` requires Git, tar, and globally installed `@openai/codex@0.153.4` (or
`CODEX_CLI_JS` pointing to its `bin/codex.js`). It installs 0.5.0 from the local tagged archive,
upgrades through a configured local marketplace to the working candidate, checks the installed cache,
and exercises the actual shell Hook commands. It does not send a model request or replace interactive
TUI validation. The default test workflow runs this smoke on every matrix entry.

## Product contract

- [x] The automatic line leads with non-reasoning output divided by end-to-end turn duration.
- [x] `reasoning_output_tokens` is validated as a subset, subtracted once from the primary numerator,
      and retained as a separate display field.
- [x] A valid `task_complete.duration_ms` replaces the provisional Stop wall-clock denominator after
      backfill; missing TTFT does not block that correction.
- [x] Session throughput is token-and-duration weighted and does not mix records whose reasoning
      breakdown is unavailable into the non-reasoning average.
- [x] Missing or invalid reasoning breakdown degrades to an explicitly named total-output fallback.
- [x] Transcript-inferred request intervals remain available only as a diagnostic reference and are
      not presented as the default rate or pure-generation TPS.
- [x] TTFT comes from Codex `task_complete.time_to_first_token_ms` and is backfilled asynchronously.
- [x] Unattributed OTel TBT is labeled as a capture reference or isolated single-turn candidate,
      always marked unjoined to the current turn.
- [x] Native OTel capture remains explicit opt-in; production Hooks never start the receiver or
      modify the user's exporter configuration.
- [x] Hook failures degrade without steering or extending the model turn.

## Runtime evidence

- [x] The synchronous handler emits strict JSON and persists only redacted numeric status.
- [x] The background handler independently backfills available TTFT and completion duration.
- [x] A later synchronous Stop recovers the previous turn's timing if asynchronous backfill was missed.
- [x] Installed-cache execution through a Windows directory junction is covered by regression tests.
- [x] Removed version caches degrade to strict empty JSON instead of a failed Hook.
- [x] Stable runtime snapshots remain bounded and cannot be rolled back by an older plugin root.
- [x] The local receiver is loopback-only, directory-exclusive, atomically written, and bounded by
      body, payload-count, and total-byte limits.
- [x] The phase-six observer remains capture-only for untested schemas/daemons and does not gain a
      passive App Server role.

## Distribution and safety

- [x] The repository contains `.agents/plugins/marketplace.json`.
- [x] The plugin is located at `plugins/codex-tps-plus` and has a valid manifest.
- [x] Manifest, root package, plugin package, changelog, and release check use version `0.6.0`.
- [x] The candidate manifest contains no local cachebuster suffix.
- [x] No raw transcript, OTLP body, credential, review note, or local absolute path is tracked.
- [x] OTel reports expose only allowlisted structure and numbers; raw `.bin` files remain explicitly
      documented as potentially sensitive.
- [x] MIT license notices and security reporting guidance remain present.

## Published v0.5.0 evidence (historical)

- The reviewed `v0.5.0` tag points to `bea3497e5022eb018ee63fa338cd7e7b3ec8ede6`.
- The [tag matrix](https://github.com/KDB-Wind/codex-tps-plus/actions/runs/33458712669) and
  [initial main matrix](https://github.com/KDB-Wind/codex-tps-plus/actions/runs/33458712814) passed
  on Windows, macOS, and Linux with Node.js 22 and 24.
- The [v0.5.0 GitHub Release](https://github.com/KDB-Wind/codex-tps-plus/releases/tag/v0.5.0)
  is public and is neither a draft nor a prerelease.
- A clean public-marketplace smoke test installed version 0.5.0, reported it enabled, validated
  the installed plugin structure, and returned strict `{}` JSON from the installed Stop collector.
