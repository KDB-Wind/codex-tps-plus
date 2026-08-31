#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectOtelCapture } from "./otel-inspect.mjs";

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
      metricsExporter: null,
      protocol: null,
    };
  }
  const section = text.match(/(?:^|\n)\s*\[otel\]\s*([\s\S]*?)(?=\n\s*\[|$)/i)?.[1] || "";
  const exporterObject = section.match(/^\s*exporter\s*=\s*\{\s*(otlp-[^\s=\}]+)/im)?.[1] || null;
  const exporterString = section.match(/^\s*exporter\s*=\s*"([^"]+)"/im)?.[1] || null;
  const metricsExporterObject = section.match(/^\s*metrics_exporter\s*=\s*\{\s*(otlp-[^\s=\}]+)/im)?.[1] || null;
  const metricsExporterString = section.match(/^\s*metrics_exporter\s*=\s*"([^"]+)"/im)?.[1] || null;
  const protocol = section.match(/protocol\s*=\s*"([^"]+)"/i)?.[1] || null;
  return {
    configPresent: true,
    otelSectionPresent: Boolean(section),
    exporter: exporterObject || exporterString,
    metricsExporter: metricsExporterObject || metricsExporterString,
    protocol,
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
  } else {
    console.error("Usage: node scripts/otel.mjs config [config.toml] | scan <capture-directory>");
    process.exitCode = 2;
  }
}
