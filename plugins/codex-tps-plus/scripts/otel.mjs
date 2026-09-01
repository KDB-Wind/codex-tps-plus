#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectOtelCapture } from "./otel-inspect.mjs";

function assignmentBlock(section, key) {
  const match = new RegExp(`^\\s*${key}\\s*=`, "im").exec(section);
  if (!match) return "";
  const tail = section.slice(match.index);
  const lines = tail.split(/\r?\n/);
  let block = "";
  let depth = 0;
  let started = false;
  for (const line of lines) {
    block += `${line}\n`;
    for (const character of line.replace(/"(?:\\.|[^"])*"/g, "")) {
      if (character === "{") {
        depth += 1;
        started = true;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (!started || depth <= 0) break;
  }
  return block;
}

function endpointFrom(section, key) {
  return assignmentBlock(section, key).match(/endpoint\s*=\s*"([^"]+)"/i)?.[1] || null;
}

function protocolFrom(section, key) {
  return assignmentBlock(section, key).match(/protocol\s*=\s*"([^"]+)"/i)?.[1] || null;
}

export function isLoopbackOtlpEndpoint(value) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function inspectOtelConfig(
  configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml")
) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return {
      configPresent: false,
      otelSectionPresent: false,
      exporter: null,
      exporterEndpoint: null,
      exporterEndpointLoopback: false,
      metricsExporter: null,
      metricsEndpoint: null,
      metricsEndpointLoopback: false,
      protocol: null,
    };
  }
  const section = text.match(/(?:^|\n)\s*\[otel\]\s*([\s\S]*?)(?=\n\s*\[|$)/i)?.[1] || "";
  const exporterObject = section.match(/^\s*exporter\s*=\s*\{\s*(otlp-[^\s=\}]+)/im)?.[1] || null;
  const exporterString = section.match(/^\s*exporter\s*=\s*"([^"]+)"/im)?.[1] || null;
  const metricsExporterObject = section.match(/^\s*metrics_exporter\s*=\s*\{\s*(otlp-[^\s=\}]+)/im)?.[1] || null;
  const metricsExporterString = section.match(/^\s*metrics_exporter\s*=\s*"([^"]+)"/im)?.[1] || null;
  const metricsEndpoint = endpointFrom(section, "metrics_exporter");
  const exporterEndpoint = endpointFrom(section, "exporter");
  const protocol = protocolFrom(section, "exporter");
  const metricsProtocol = protocolFrom(section, "metrics_exporter");
  return {
    configPresent: true,
    otelSectionPresent: Boolean(section),
    exporter: exporterObject || exporterString,
    exporterEndpoint,
    exporterEndpointLoopback: isLoopbackOtlpEndpoint(exporterEndpoint),
    metricsExporter: metricsExporterObject || metricsExporterString,
    metricsEndpoint,
    metricsEndpointLoopback: isLoopbackOtlpEndpoint(metricsEndpoint),
    protocol,
    metricsProtocol,
    logUserPromptRedacted: /log_user_prompt\s*=\s*false/i.test(section),
  };
}

export function scanOtelCapture(directory) {
  const structural = inspectOtelCapture(directory);
  if (structural.directoryPresent) return structural;
  return {
    directoryPresent: false,
    requestCount: 0,
    signals: [],
    perRequestJoinable: false,
    conclusion: "no_capture",
  };
}

if (process.argv[1]?.endsWith("otel.mjs")) {
  const command = process.argv[2];
  if (command === "config") {
    console.log(JSON.stringify(inspectOtelConfig(process.argv[3]), null, 2));
  } else if (command === "scan" && process.argv[3]) {
    console.log(JSON.stringify(scanOtelCapture(process.argv[3]), null, 2));
  } else if (command === "serve") {
    await import("./otel-receiver.mjs");
  } else {
    console.error("Usage: node scripts/otel.mjs config [config.toml] | scan <capture-directory> | serve [receiver options]");
    process.exitCode = 2;
  }
}
