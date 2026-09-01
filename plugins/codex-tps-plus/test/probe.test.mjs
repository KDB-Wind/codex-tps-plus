import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureHookObservation,
  summarizeHookInput,
  summarizeTranscript,
  writeObservation,
} from "../scripts/probe-core.mjs";
import {
  classifyTpsEvidence,
  outputTokensForRate,
  requestRate,
  weightedRate,
} from "../scripts/metric-model.mjs";
import {
  assessOtelCaptureIsolation,
  assessOtelExporter,
  selectPluginInstallation,
} from "../scripts/doctor-core.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = (name) => path.join(root, "test", "fixtures", name);

test("legacy and paginated transcript metadata are distinguishable", () => {
  const legacy = summarizeTranscript(fixture("legacy-session.jsonl"), { currentTurnId: "turn-legacy-1" });
  const paginated = summarizeTranscript(fixture("paginated-session.jsonl"), { currentTurnId: "turn-paginated-1" });
  assert.equal(legacy.available, true);
  assert.equal(legacy.format, "legacy");
  assert.equal(legacy.currentTurn.tokenCountEvents, 1);
  assert.equal(legacy.currentTurn.taskCompleteEvents, 1);
  assert.equal(paginated.format, "paginated");
  assert.equal(paginated.currentTurn.tokenCountEvents, 1);
  assert.equal(paginated.currentTurn.taskCompleteEvents, 0);
  assert.ok(paginated.selectedEvents.some((event) => event.payloadType === "turn_interrupted"));
});

test("Stop snapshot preserves absence of a later task_complete", () => {
  const summary = summarizeTranscript(fixture("stop-before-complete.jsonl"), { currentTurnId: "turn-stop-1" });
  assert.equal(summary.currentTurn.tokenCountEvents, 1);
  assert.equal(summary.currentTurn.taskCompleteEvents, 0);
  assert.equal(summary.selectedEvents.at(-1).payloadType, "token_count");
});

test("redacted live Stop fixture records multiple token snapshots without declaring request boundaries", () => {
  const observed = JSON.parse(fs.readFileSync(fixture("observed-stop-paginated.json"), "utf8"));
  assert.equal(observed.stop.transcript.format, "paginated");
  assert.equal(observed.stop.transcript.currentTurn.tokenCountEvents, 2);
  assert.equal(observed.stop.transcript.currentTurn.taskCompleteEvents, 0);
  assert.deepEqual(
    observed.stop.transcript.tokenCounts.map((item) => item.lastTokenUsage.outputTokens),
    [393, 90]
  );
  assert.equal(observed.finalTranscript.taskComplete.observedAfterStop, true);
  assert.equal(JSON.stringify(observed).includes("session-secret"), false);
});

test("malformed tail degrades to a parse error without exposing raw text", () => {
  const summary = summarizeTranscript(fixture("malformed-tail.jsonl"), { currentTurnId: "turn-malformed-1" });
  assert.equal(summary.available, true);
  assert.equal(summary.parseErrorCount, 1);
  assert.deepEqual(summary.parseErrorLines, [5]);
  assert.equal(summary.currentTurn.taskCompleteEvents, 1);
  assert.equal(JSON.stringify(summary).includes("token_count\\\"}"), false);
});

test("hook input is structurally useful but redacts prompt, paths, and identifiers", () => {
  const summary = summarizeHookInput({
    session_id: "session-secret",
    turn_id: "turn-secret",
    cwd: "C:\\Users\\KDB\\Sensitive Workspace",
    transcript_path: "C:\\Users\\KDB\\Sensitive Workspace\\rollout.jsonl",
    hook_event_name: "Stop",
    model: "gpt-test",
    prompt: "do not persist this prompt",
    last_assistant_message: "do not persist this answer",
    tool_input: { command: "do not persist this command", cwd: "private" },
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("do not persist"), false);
  assert.equal(serialized.includes("Sensitive Workspace"), false);
  assert.equal(summary.prompt.length, 26);
  assert.equal(summary.lastAssistantMessage.length, 26);
  assert.equal(summary.toolInput.command.length, 27);
  assert.match(summary.sessionId, /^[0-9a-f]{12}$/);
});

test("rate model uses output_tokens once and weighted duration", () => {
  assert.equal(outputTokensForRate({ output_tokens: 593, reasoning_output_tokens: 450 }), 593);
  assert.equal(requestRate({ output_tokens: 100, reasoning_output_tokens: 40, generation_ms: 1000 }), 100);
  assert.equal(
    weightedRate([
      { output_tokens: 100, reasoning_output_tokens: 50, generation_ms: 1000 },
      { output_tokens: 100, reasoning_output_tokens: 50, generation_ms: 9000 },
    ]),
    20
  );
  assert.equal(
    classifyTpsEvidence({ hasOutputTokens: true, hasPureGenerationDuration: false, hasEndToEndDuration: true }),
    "throughput_only"
  );
  assert.equal(
    classifyTpsEvidence({ hasOutputTokens: true, hasPureGenerationDuration: true, hasEndToEndDuration: true }),
    "tps_candidate"
  );
});

test("collector emits strict JSON and writes a redacted observation", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-test-"));
  const collector = path.join(root, "hooks", "collector.mjs");
  const stdout = execFileSync(process.execPath, [collector, "Stop"], {
    input: JSON.stringify({
      session_id: "session-test",
      turn_id: "turn-test",
      hook_event_name: "Stop",
      cwd: "C:\\Sensitive",
      transcript_path: fixture("legacy-session.jsonl"),
      last_assistant_message: "private message",
    }),
    env: { ...process.env, TPS_PROBE_DIR: temp },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(stdout), {});
  const observations = fs.readdirSync(temp).filter((name) => name.endsWith(".json"));
  assert.equal(observations.length, 1);
  const observation = JSON.parse(fs.readFileSync(path.join(temp, observations[0]), "utf8"));
  assert.equal(observation.eventName, "Stop");
  assert.equal(observation.transcript.format, "legacy");
  assert.equal(JSON.stringify(observation).includes("private message"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("collector is a no-op unless TPS_PROBE_DIR is explicitly set", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-disabled-"));
  const collector = path.join(root, "hooks", "collector.mjs");
  const env = { ...process.env, PLUGIN_DATA: temp };
  delete env.TPS_PROBE_DIR;
  const stdout = execFileSync(process.execPath, [collector, "Stop"], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      transcript_path: fixture("legacy-session.jsonl"),
    }),
    env,
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(stdout), {});
  assert.deepEqual(fs.readdirSync(temp), []);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("high-frequency tool hooks do not read the transcript", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-tool-"));
  const collector = path.join(root, "hooks", "collector.mjs");
  const stdout = execFileSync(process.execPath, [collector, "PreToolUse"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      transcript_path: fixture("legacy-session.jsonl"),
      tool_name: "Bash",
      tool_input: { command: "private command" },
    }),
    env: { ...process.env, TPS_PROBE_DIR: temp },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(stdout), {});
  const observationFile = fs.readdirSync(temp).find((name) => name.endsWith(".json"));
  const observation = JSON.parse(fs.readFileSync(path.join(temp, observationFile), "utf8"));
  assert.equal(observation.transcript.available, false);
  assert.equal(observation.transcript.reason, "event_not_selected");
  assert.equal(JSON.stringify(observation).includes("private command"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("observation retention caps managed files without touching unrelated files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-retention-"));
  fs.writeFileSync(path.join(temp, "keep.txt"), "unrelated", "utf8");
  for (let index = 0; index < 3; index += 1) {
    writeObservation(
      temp,
      captureHookObservation({ eventName: "Stop", input: {}, includeTranscript: false }),
      { maxFiles: 2, maxBytes: 1024 * 1024 }
    );
  }
  assert.equal(fs.readdirSync(temp).filter((name) => name.endsWith(".json")).length, 2);
  assert.equal(fs.readFileSync(path.join(temp, "keep.txt"), "utf8"), "unrelated");
  fs.rmSync(temp, { recursive: true, force: true });
});

test("release configuration registers one Stop event with sync display and async TTFT backfill", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks), ["Stop"]);
  assert.equal(hooks.Stop[0].hooks.length, 2);
  assert.match(hooks.Stop[0].hooks[0].command, /collector\.mjs/);
  assert.match(hooks.Stop[0].hooks[0].command, /PLUGIN_DATA.*runtime\/dispatch\.mjs/);
  assert.match(hooks.Stop[0].hooks[0].commandWindows, /PLUGIN_DATA.*runtime\\dispatch\.mjs/);
  assert.equal(hooks.Stop[0].hooks[0].async, undefined);
  assert.match(hooks.Stop[0].hooks[1].command, /backfill\.mjs/);
  assert.match(hooks.Stop[0].hooks[1].command, /PLUGIN_DATA.*runtime\/dispatch\.mjs/);
  assert.match(hooks.Stop[0].hooks[1].commandWindows, /PLUGIN_DATA.*runtime\\dispatch\.mjs/);
  assert.equal(hooks.Stop[0].hooks[1].async, true);
});

test("doctor prefers the installation matching the running plugin version", () => {
  const selected = selectPluginInstallation(
    [
      {
        pluginId: "codex-tps-plus@personal",
        name: "codex-tps-plus",
        version: "0.4.0+codex.dev",
        installed: true,
        enabled: true,
      },
      {
        pluginId: "codex-tps-plus@kdb-wind",
        name: "codex-tps-plus",
        version: "0.4.0",
        installed: true,
        enabled: true,
      },
    ],
    "0.4.0"
  );
  assert.equal(selected.pluginId, "codex-tps-plus@kdb-wind");
});

test("doctor rejects an enabled installation from an older semver release", () => {
  const selected = selectPluginInstallation(
    [
      {
        pluginId: "codex-tps-plus@personal",
        name: "codex-tps-plus",
        version: "0.4.0",
        installed: true,
        enabled: true,
      },
    ],
    "0.5.0"
  );
  assert.equal(selected, null);
});

test("doctor separates receiver exclusivity from conversation isolation", () => {
  const isolated = assessOtelCaptureIsolation({
    receiver: { active: true, receiverIdCount: 1 },
    captureIsolation: { level: "single-conversation-observed", distinctConversationCount: 1 },
  });
  assert.equal(isolated.receiverExclusive, true);
  assert.equal(isolated.concurrentContamination, false);
  assert.equal(isolated.singleTurnCandidateEligible, false);

  const contaminated = assessOtelCaptureIsolation({
    receiver: { active: true, receiverIdCount: 1 },
    captureIsolation: { level: "concurrent-conversations-observed", distinctConversationCount: 2 },
  });
  assert.equal(contaminated.concurrentContamination, true);
  assert.equal(contaminated.singleTurnCandidateEligible, false);
});

test("doctor requires a loopback metrics exporter matching the receiver", () => {
  const matching = assessOtelExporter(
    {
      metricsExporter: "otlp-http",
      metricsEndpoint: "http://127.0.0.1:4318/v1/metrics",
      metricsEndpointLoopback: true,
      exporter: "otlp-http",
      exporterEndpoint: "http://127.0.0.1:4318/v1/logs",
      exporterEndpointLoopback: true,
    },
    { endpoint: "http://127.0.0.1:4318" }
  );
  assert.equal(matching.configured, true);
  assert.equal(matching.matchesReceiver, true);
  assert.equal(matching.logsMatchReceiver, true);
  const remote = assessOtelExporter(
    {
      metricsExporter: "otlp-http",
      metricsEndpoint: "https://collector.example/v1/metrics",
      metricsEndpointLoopback: false,
    },
    { endpoint: "http://127.0.0.1:4318" }
  );
  assert.equal(remote.matchesReceiver, false);
});

test("probe report ignores unrelated JSON files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-report-"));
  writeObservation(temp, captureHookObservation({ eventName: "Stop", input: {}, includeTranscript: false }));
  fs.writeFileSync(path.join(temp, "unrelated.json"), JSON.stringify({ secret: "must-not-appear" }), "utf8");
  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts", "probe-report.mjs"), temp, "--json"],
    { encoding: "utf8" }
  );
  const report = JSON.parse(output);
  assert.equal(report.observationCount, 1);
  assert.equal(output.includes("must-not-appear"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});
