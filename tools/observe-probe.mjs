#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ProbeCaptureWriter,
  ProbeState,
  assertIndependentOutputDirectory,
  configureStateForRun,
  prepareRunDirectory,
} from "./observe-probe-core.mjs";
import {
  JsonRpcClient,
  JsonRpcTransport,
  parseEndpoint,
} from "./observe-probe-transport.mjs";

const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_UNSUBSCRIBE_TIMEOUT_MS = 1_000;

function numericOption(value, name, fallback, { minimum = 1 } = {}) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name}_invalid`);
  return number;
}

export function parseProbeArgs(argv = process.argv.slice(2)) {
  const options = {
    schemaVersion: "v2",
    schemaVersionSource: "cli_default",
    durationMs: DEFAULT_DURATION_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    unsubscribeTimeoutMs: DEFAULT_UNSUBSCRIBE_TIMEOUT_MS,
    reconnectAttempts: 0,
    reconnectDelayMs: 250,
    disconnectAfterMs: null,
    cleanupTimeoutMs: 30_000,
    maxEvents: 5_000,
    maxTurns: 200,
    maxItemsPerTurn: 500,
    maxUsageUpdates: 2_000,
    maxBytes: 16 * 1024 * 1024,
    maxFiles: 2,
    usageTerminalVerified: false,
    help: false,
  };
  const values = new Map();
  const booleans = new Set(["usage-terminal-verified", "help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error("argument_must_start_with_dash");
    const name = arg.slice(2);
    if (booleans.has(name)) {
      values.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name}_value_required`);
    values.set(name, value);
    index += 1;
  }
  const known = new Set([
    "endpoint",
    "out",
    "thread-id",
    "schema-version",
    "daemon-version",
    "duration-ms",
    "request-timeout-ms",
    "unsubscribe-timeout-ms",
    "reconnect-attempts",
    "reconnect-delay-ms",
    "disconnect-after-ms",
    "cleanup-timeout-ms",
    "max-events",
    "max-turns",
    "max-items-per-turn",
    "max-usage-updates",
    "max-bytes",
    "max-files",
    "usage-terminal-verified",
  ]);
  for (const name of values.keys()) if (!known.has(name)) throw new Error(`unknown_argument_${name}`);
  options.endpoint = values.get("endpoint");
  options.out = values.get("out");
  options.threadId = values.get("thread-id") || null;
  if (values.has("schema-version")) {
    options.schemaVersion = values.get("schema-version");
    options.schemaVersionSource = "cli_argument";
  }
  options.daemonVersion = values.get("daemon-version") || null;
  options.durationMs = numericOption(values.get("duration-ms"), "duration_ms", options.durationMs);
  options.requestTimeoutMs = numericOption(
    values.get("request-timeout-ms"),
    "request_timeout_ms",
    options.requestTimeoutMs
  );
  options.unsubscribeTimeoutMs = numericOption(
    values.get("unsubscribe-timeout-ms"),
    "unsubscribe_timeout_ms",
    options.unsubscribeTimeoutMs
  );
  options.reconnectAttempts = numericOption(
    values.get("reconnect-attempts"),
    "reconnect_attempts",
    options.reconnectAttempts,
    { minimum: 0 }
  );
  options.reconnectDelayMs = numericOption(
    values.get("reconnect-delay-ms"),
    "reconnect_delay_ms",
    options.reconnectDelayMs,
    { minimum: 0 }
  );
  options.disconnectAfterMs = values.has("disconnect-after-ms")
    ? numericOption(values.get("disconnect-after-ms"), "disconnect_after_ms", 0, { minimum: 0 })
    : null;
  options.cleanupTimeoutMs = numericOption(
    values.get("cleanup-timeout-ms"),
    "cleanup_timeout_ms",
    options.cleanupTimeoutMs,
    { minimum: 0 }
  );
  options.maxEvents = numericOption(values.get("max-events"), "max_events", options.maxEvents);
  options.maxTurns = numericOption(values.get("max-turns"), "max_turns", options.maxTurns);
  options.maxItemsPerTurn = numericOption(
    values.get("max-items-per-turn"),
    "max_items_per_turn",
    options.maxItemsPerTurn
  );
  options.maxUsageUpdates = numericOption(
    values.get("max-usage-updates"),
    "max_usage_updates",
    options.maxUsageUpdates
  );
  options.maxBytes = numericOption(values.get("max-bytes"), "max_bytes", options.maxBytes);
  options.maxFiles = numericOption(values.get("max-files"), "max_files", options.maxFiles);
  options.usageTerminalVerified = values.has("usage-terminal-verified");
  if (!options.help && (!options.endpoint || !options.out)) {
    throw new Error("endpoint_and_out_required");
  }
  return options;
}

export function helpText() {
  return [
    "Usage: node tools/observe-probe.mjs --endpoint <loopback-endpoint> --out <capture-dir> [options]",
    "",
    "The output directory is a unique run directory (or a child run-* directory when --out is non-empty).",
    "Allowed transports: ws://127.0.0.1:PORT, wss://127.0.0.1:PORT, unix://PATH, stdio://.",
    "With stdio://, the final probe result is written to stderr so stdout remains JSON-RPC.",
    "",
    "Options:",
    "  --thread-id ID                 Explicitly select a thread when discovery returns multiple threads",
    "  --schema-version VERSION       Protocol schema label; untested labels are capture-only and disable LIVE/TTFT/usage (default: v2)",
    "  --daemon-version VERSION       Known daemon label; unknown labels are capture-only and disable LIVE/TTFT/usage",
    "  --duration-ms N                Observation duration (default: 60000)",
    "  --unsubscribe-timeout-ms N    Short best-effort unsubscribe budget (default: 1000)",
    "  --reconnect-attempts N         Reconnect after an unexpected close (default: 0)",
    "  --disconnect-after-ms N        Deliberately close once, useful for controlled disconnect tests",
    "  --cleanup-timeout-ms N         Memory cleanup delay; never a turn-completion timeout",
    "  --max-events N --max-bytes N   Bounds for the event stream",
    "  --max-turns N --max-items-per-turn N --max-usage-updates N --max-files N",
    "  --usage-terminal-verified      Explicit E4 evidence permits abnormal-turn partialUsage",
    "  --help",
  ].join("\n");
}

class ProbeControlError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeControlError";
    this.code = code;
  }
}

function errorCode(error, fallback = "probe_failed") {
  if (typeof error?.code === "string" && error.code) return error.code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  if (error instanceof ProbeControlError) return error.code;
  return fallback;
}

function delay(ms, signal = null) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ aborted: false }), Math.max(0, ms));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ aborted: true });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function waitForConnectionOrDeadline(handle, deadlineMs, signal) {
  const remaining = Math.max(0, deadlineMs - Date.now());
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ elapsed: true }), remaining);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ aborted: true });
    handle.closePromise.then((reason) => finish({ closed: true, reason }));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function safeTransportSummary(endpoint) {
  const parsed = parseEndpoint(endpoint);
  return {
    kind: parsed.kind,
    endpointKind: parsed.endpointKind,
    loopback: parsed.kind === "websocket" ? true : null,
  };
}

export function initParams() {
  return {
    clientInfo: {
      name: "codex-tps-plus-phase-six-probe",
      version: "phase-six-probe-0.1.0",
    },
    capabilities: {
      // thread/resume.excludeTurns is gated behind this experimental API
      // capability in the current app-server protocol. This is a negotiation
      // flag only; the probe still sends no control or turn-start methods.
      experimentalApi: true,
    },
  };
}

function createTransport(endpoint, options) {
  return new JsonRpcTransport(endpoint, {
    requestTimeoutMs: options.requestTimeoutMs,
    maxMessageBytes: options.maxBytes,
  });
}

async function makeConnection(state, options, activeHandleRef, transportFactory) {
  let closeResolve;
  const closePromise = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const transport = transportFactory(options.endpoint, options);
  const client = new JsonRpcClient(transport, {
    requestTimeoutMs: options.requestTimeoutMs,
    beforeSend: (method, params) => state.recordOutgoing(method, params),
    onNotification: (message) => state.handleNotification(message),
    onServerRequest: (message) => state.handleServerRequest(message),
    onResponse: (method, result, error) => state.recordResponse(method, result, error),
    onClose: (reason) => {
      state.connectionClosed(reason || "transport_closed");
      closeResolve(reason || "transport_closed");
    },
    onTransportError: (code) => {
      state.recordError(code);
      if (/message_|unmatched_rpc/.test(String(code))) client.close(String(code));
    },
  });
  const handle = { client, closePromise };
  activeHandleRef.current = handle;
  await client.connect();
  state.openConnection();

  const initializeStartedAt = Date.now();
  const initialized = await client.request("initialize", initParams());
  state.handshake.initialize.roundTripMs = Date.now() - initializeStartedAt;
  if (!initialized || typeof initialized !== "object") throw new ProbeControlError("initialize_response_invalid");
  client.notify("initialized");
  return handle;
}

async function requestWithAudit(state, client, method, params, requestOptions = {}) {
  try {
    return await client.request(method, params, requestOptions);
  } catch (error) {
    state.recordError(errorCode(error, "rpc_request_failed"));
    throw error;
  }
}

function notifyWithAudit(state, client, method, params) {
  client.notify(method, params);
}

async function discoverThread(state, client, options) {
  if (state.selectedThreadId) return state.selectedThreadId;
  let loadedResult = null;
  try {
    loadedResult = await requestWithAudit(state, client, "thread/loaded/list", {});
  } catch {
    state.recordError("thread_loaded_list_failed");
  }
  let candidates = state.discovery.candidates;
  if (!loadedResult || candidates.length === 0) {
    try {
      await requestWithAudit(state, client, "thread/list", { archived: false, limit: 100 });
      candidates = state.discovery.candidates;
    } catch {
      state.recordError("thread_list_failed");
    }
  }
  const selection = state.recordDiscoverySelection(candidates, options.threadId);
  if (!selection.selected) {
    throw new ProbeControlError(selection.requiresManualThreadId
      ? "multiple_active_threads_requires_thread_id"
      : "no_active_thread_found");
  }
  return selection.selected;
}

async function subscribeToThread(state, client, options, reconnecting) {
  const threadId = await discoverThread(state, client, options);
  const result = await requestWithAudit(state, client, "thread/resume", {
    threadId,
    excludeTurns: true,
  });
  if (!result || typeof result !== "object") throw new ProbeControlError("resume_response_invalid");
  if (state.e1Failures.length) throw new ProbeControlError("e1_protocol_invariant_failed");
  if (reconnecting) state.markReconnected();
}

export async function runProbe(options = {}) {
  const endpoint = options.endpoint;
  const out = options.out;
  const transportSummary = safeTransportSummary(endpoint);
  const outputRoot = assertIndependentOutputDirectory(out, options.env || process.env);
  const runDirectory = prepareRunDirectory(outputRoot);
  const writer = new ProbeCaptureWriter(runDirectory, options);
  let activeHandle = null;
  const activeHandleRef = {
    get current() {
      return activeHandle;
    },
    set current(value) {
      activeHandle = value;
    },
  };
  const state = configureStateForRun(new ProbeState({
    schemaVersion: options.schemaVersion || "v2",
    schemaVersionSource: options.schemaVersionSource || "caller_supplied",
    threadId: options.threadId || null,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    maxTurns: options.maxTurns,
    maxItemsPerTurn: options.maxItemsPerTurn,
    maxUsageUpdates: options.maxUsageUpdates,
    usageTerminalVerified: options.usageTerminalVerified,
    eventSink: (event) => writer.write(event),
    onE1Failure: () => {
      try {
        activeHandleRef.current?.client.close("e1_failure");
      } catch {}
    },
  }), {
    transportSummary,
    usageTerminalVerified: options.usageTerminalVerified,
  });
  if (options.daemonVersion) state.setDaemonVersion(options.daemonVersion, "cli_argument");
  const transportFactory = options.transportFactory || ((target, factoryOptions) => createTransport(target, factoryOptions));
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal || controller.signal;
  const deadline = Date.now() + (options.durationMs || DEFAULT_DURATION_MS);
  let exitCode = 0;
  let reconnectsUsed = 0;
  let firstConnection = true;
  let disconnectTimer = null;
  let stopRequested = false;
  let fatalStopRequested = false;
  const shouldStop = () => stopRequested || Boolean(signal?.aborted);
  const onUncaught = () => {
    stopRequested = true;
    fatalStopRequested = true;
    state.recordError("uncaught_exception");
    controller?.abort();
  };
  const onUnhandled = () => {
    stopRequested = true;
    fatalStopRequested = true;
    state.recordError("unhandled_rejection");
    controller?.abort();
  };
  const onSignal = (signalName) => {
    stopRequested = true;
    state.recordError(`signal_${signalName.toLowerCase()}`);
    if (controller) controller.abort();
    else {
      try {
        activeHandleRef.current?.client.close(`probe_${signalName.toLowerCase()}`);
      } catch {}
    }
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("uncaughtException", onUncaught);
  process.once("unhandledRejection", onUnhandled);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    while (!shouldStop() && Date.now() < deadline) {
      const reconnecting = !firstConnection;
      try {
        const handle = await makeConnection(state, options, activeHandleRef, transportFactory);
        activeHandle = handle;
        await subscribeToThread(state, handle.client, options, reconnecting);
        if (shouldStop()) {
          handle.client.close("probe_aborted");
          break;
        }
        if (state.e1Failures.length) {
          exitCode = 1;
          handle.client.close("e1_failure");
          break;
        }
        if (firstConnection && options.disconnectAfterMs !== null && options.disconnectAfterMs !== undefined) {
          disconnectTimer = setTimeout(() => {
            try {
              handle.client.close("probe_requested_disconnect");
            } catch {}
          }, options.disconnectAfterMs);
        }
        const result = await waitForConnectionOrDeadline(handle, deadline, signal);
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
        if (result.elapsed || result.aborted) {
          if (!state.e1Failures.length && state.connected && state.selectedThreadId) {
            try {
              await requestWithAudit(state, handle.client, "thread/unsubscribe", {
                threadId: state.selectedThreadId,
              }, {
                timeoutMs: options.unsubscribeTimeoutMs ?? Math.min(
                  options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
                  DEFAULT_UNSUBSCRIBE_TIMEOUT_MS
                ),
              });
            } catch {
              state.recordError("unsubscribe_failed");
            }
          }
          handle.client.close(result.aborted ? "probe_aborted" : "probe_duration_elapsed");
          break;
        }
        if (state.e1Failures.length) {
          exitCode = 1;
          break;
        }
        firstConnection = false;
        if (shouldStop() || reconnectsUsed >= (options.reconnectAttempts || 0) || Date.now() >= deadline) break;
        reconnectsUsed += 1;
        const delayed = await delay(options.reconnectDelayMs || 0, signal);
        if (delayed.aborted || shouldStop()) break;
      } catch (error) {
        if (shouldStop()) exitCode = 0;
        else if (state.e1Failures.length) exitCode = 1;
        else if (error instanceof ProbeControlError && error.code === "multiple_active_threads_requires_thread_id") exitCode = 2;
        else exitCode = 2;
        state.recordError(errorCode(error));
        try {
          activeHandleRef.current?.client.close(errorCode(error));
        } catch {}
        break;
      }
      firstConnection = false;
    }
  } finally {
    if (disconnectTimer) clearTimeout(disconnectTimer);
    try {
      activeHandleRef.current?.client.close("probe_finalized");
    } catch {}
    if (state.connected) state.connectionClosed("probe_finalized");
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  if (state.e1Failures.length || fatalStopRequested) exitCode = 1;
  const finalized = writer.finalize(state.summary());
  return {
    exitCode,
    runDirectory,
    summaryPath: finalized.summaryPath,
    summary: finalized.summary,
  };
}

async function main() {
  let options;
  try {
    options = parseProbeArgs();
  } catch (error) {
    process.stderr.write(`probe argument error: ${errorCode(error, "invalid_arguments")}\n`);
    process.stderr.write(`${helpText()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  try {
    const result = await runProbe(options);
    const output = parseEndpoint(options.endpoint).kind === "stdio" ? process.stderr : process.stdout;
    output.write(`${JSON.stringify({
      runDirectory: result.runDirectory,
      summaryPath: result.summaryPath,
      exitCode: result.exitCode,
      captureOnly: result.summary.captureOnly,
      captureSuggested: result.summary.captureSuggested,
      schemaVersionSource: result.summary.schemaVersionSource,
      e1Status: result.summary.e1.status,
    })}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`probe failed: ${errorCode(error)}\n`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();

export { fileURLToPath };
