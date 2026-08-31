#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const OBSERVATION_FILE_PATTERN = /^\d+-\d+-[A-Za-z0-9_-]+-[0-9a-f]{10}\.json$/;

function readObservations(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && OBSERVATION_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
}

export function summarizeProbeRun(directory) {
  const observations = readObservations(directory);
  const eventCounts = {};
  for (const observation of observations) {
    eventCounts[observation.eventName] = (eventCounts[observation.eventName] || 0) + 1;
  }
  const stopChecks = observations
    .filter((observation) => observation.eventName === "Stop")
    .map((observation) => ({
      capturedAt: observation.capturedAt,
      inputKeys: observation.input?.inputKeys || [],
      turnId: observation.input?.turnId ?? null,
      transcriptAvailable: observation.transcript?.available ?? false,
      transcriptFormat: observation.transcript?.format ?? null,
      tokenCountEvents: observation.transcript?.currentTurn?.tokenCountEvents ?? 0,
      taskCompleteEvents: observation.transcript?.currentTurn?.taskCompleteEvents ?? 0,
      taskCompleteSeenBeforeStop: (observation.transcript?.currentTurn?.taskCompleteEvents ?? 0) > 0,
      lastSelectedEvent: observation.transcript?.selectedEvents?.at(-1)?.payloadType ?? null,
      parseErrorCount: observation.transcript?.parseErrorCount ?? null,
      readDurationMs:
        observation.transcript?.readFinishedAtMs != null && observation.transcript?.readStartedAtMs != null
          ? observation.transcript.readFinishedAtMs - observation.transcript.readStartedAtMs
          : null,
    }));

  return {
    reportVersion: 1,
    observationCount: observations.length,
    eventCounts,
    stopChecks,
    observations: observations.map((observation) => ({
      eventName: observation.eventName,
      capturedAt: observation.capturedAt,
      input: observation.input,
      transcript: {
        available: observation.transcript?.available ?? false,
        format: observation.transcript?.format ?? null,
        lineCount: observation.transcript?.lineCount ?? null,
        recordCount: observation.transcript?.recordCount ?? null,
        parseErrorCount: observation.transcript?.parseErrorCount ?? null,
        currentTurn: observation.transcript?.currentTurn ?? null,
        lastEvent: observation.transcript?.selectedEvents?.at(-1) ?? null,
      },
    })),
  };
}

const directory = process.argv[2];
if (!directory || directory === "--help" || directory === "-h") {
  console.error("Usage: node scripts/probe-report.mjs <probe-run-directory> [--json]");
  process.exitCode = directory ? 0 : 2;
} else {
  const report = summarizeProbeRun(directory);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`观察文件: ${report.observationCount}`);
    console.log(`事件: ${Object.entries(report.eventCounts).map(([name, count]) => `${name}=${count}`).join(" · ") || "无"}`);
    for (const check of report.stopChecks) {
      console.log(
        `Stop @ ${check.capturedAt}: token_count=${check.tokenCountEvents}, task_complete=${check.taskCompleteEvents}, ` +
          `task_complete-before-Stop=${check.taskCompleteSeenBeforeStop}, transcript=${check.transcriptFormat || "-"}`
      );
    }
  }
}
