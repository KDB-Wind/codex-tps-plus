#!/usr/bin/env node

// Local-only OTLP HTTP sink for an opt-in feasibility run. OTLP bodies are raw,
// potentially sensitive bytes. They are never forwarded or printed.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function writePrivateAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

const outputDir = path.resolve(option("--output-dir", path.join(os.tmpdir(), "codex-tps-plus-otel")));
const requestedPort = Number(option("--port", "0"));
const maxBodyBytes = positiveInteger(option("--max-body-bytes", "67108864"), 64 * 1024 * 1024);
const readyFile = process.argv.includes("--ready-file")
  ? path.resolve(option("--ready-file", path.join(outputDir, "ready.json")))
  : null;
if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error("--port must be an integer from 0 through 65535");
}
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

let sequence = 0;
const server = http.createServer((request, response) => {
  let requestPath;
  try {
    requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
  } catch {
    response.writeHead(400, { "content-type": "text/plain", connection: "close" });
    response.end("bad request");
    return;
  }
  if (request.method !== "POST" || !["/v1/logs", "/v1/metrics", "/v1/traces"].includes(requestPath)) {
    response.writeHead(404, { "content-type": "text/plain", connection: "close" });
    response.end("not found");
    return;
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  request.on("data", (chunk) => {
    length += chunk.length;
    if (length <= maxBodyBytes) chunks.push(chunk);
    else {
      tooLarge = true;
      chunks.length = 0;
    }
  });
  request.on("end", () => {
    if (tooLarge) {
      response.writeHead(413, { "content-type": "text/plain", connection: "close" });
      response.end("payload too large");
      return;
    }
    const body = Buffer.concat(chunks);
    const stamp = `${Date.now()}-${process.pid}-${sequence++}`;
    const bodyFile = `${stamp}.bin`;
    const metaFile = `${stamp}.meta.json`;
    const bodyPath = path.join(outputDir, bodyFile);
    const metaPath = path.join(outputDir, metaFile);
    try {
      writePrivateAtomic(bodyPath, body);
      writePrivateAtomic(
        metaPath,
        JSON.stringify(
          {
            receivedAt: new Date().toISOString(),
            method: request.method,
            url: requestPath,
            contentType: request.headers["content-type"] || null,
            contentLength: body.length,
            bodyFile,
            rawCaptureSensitive: true,
          },
          null,
          2
        )
      );
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    } catch {
      for (const file of [metaPath, bodyPath]) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("capture failed");
    }
  });
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const ready = { host: "127.0.0.1", port, outputDir, pid: process.pid };
  if (readyFile) {
    writePrivateAtomic(readyFile, JSON.stringify(ready, null, 2));
  }
  console.log(JSON.stringify(ready));
  console.error("Warning: captured OTLP .bin files are raw and may contain sensitive data; delete them after inspection.");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
