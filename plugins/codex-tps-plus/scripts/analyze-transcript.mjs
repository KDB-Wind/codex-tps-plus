#!/usr/bin/env node

import { summarizeTranscript } from "./probe-core.mjs";

const transcriptPath = process.argv[2];
if (!transcriptPath || transcriptPath === "--help" || transcriptPath === "-h") {
  console.error("Usage: node scripts/analyze-transcript.mjs <transcript.jsonl>");
  process.exitCode = transcriptPath ? 0 : 2;
} else {
  const summary = summarizeTranscript(transcriptPath, { maxEvents: 500 });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.available) process.exitCode = 1;
}
