#!/usr/bin/env node

// Local-only OTLP HTTP sink for an opt-in feasibility run. OTLP bodies are raw,
// potentially sensitive bytes. They are never forwarded or printed.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
const maxFiles = positiveInteger(option("--max-files", "1000"), 1000);
const maxTotalBytes = positiveInteger(option("--max-total-bytes", "536870912"), 512 * 1024 * 1024);
const readyFile = process.argv.includes("--ready-file")
  ? path.resolve(option("--ready-file", path.join(outputDir, "ready.json")))
  : null;
if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error("--port must be an integer from 0 through 65535");
}
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const receiverId = crypto.randomBytes(16).toString("hex");
const lockPath = path.join(outputDir, "receiver.lock");
let lockHandle = null;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    lockHandle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(
      lockHandle,
      `${JSON.stringify({ schemaVersion: 1, receiverId, pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );
    break;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {}
    if (processAlive(Number(existing?.pid))) {
      throw new Error(`capture directory already has an active receiver (pid ${existing.pid})`);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}
if (lockHandle === null) throw new Error("could not acquire capture directory lock");

let sequence = 0;
function pruneCaptures() {
  try {
    const captures = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d+-\d+-\d+\.meta\.json$/.test(entry.name))
      .map((entry) => {
        const metaPath = path.join(outputDir, entry.name);
        const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const bodyPath = path.join(outputDir, path.basename(metadata.bodyFile || ""));
        const metaStat = fs.statSync(metaPath);
        let bodySize = 0;
        try {
          bodySize = fs.statSync(bodyPath).size;
        } catch {}
        return { metaPath, bodyPath, size: metaStat.size + bodySize, mtimeMs: metaStat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.metaPath.localeCompare(right.metaPath));
    let totalBytes = captures.reduce((total, item) => total + item.size, 0);
    while (captures.length > maxFiles || totalBytes > maxTotalBytes) {
      const oldest = captures.shift();
      if (!oldest) break;
      totalBytes -= oldest.size;
      for (const file of [oldest.metaPath, oldest.bodyPath]) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
    }
  } catch {}
}

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
            receiverId,
            schemaVersion: 1,
            rawCaptureSensitive: true,
          },
          null,
          2
        )
      );
      pruneCaptures();
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
  const ready = {
    schemaVersion: 1,
    receiverId,
    host: "127.0.0.1",
    port,
    endpoint: `http://127.0.0.1:${port}`,
    outputDir,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    rawCaptureSensitive: true,
    retention: { maxFiles, maxTotalBytes, maxBodyBytes },
  };
  writePrivateAtomic(path.join(outputDir, "receiver.json"), JSON.stringify(ready, null, 2));
  if (readyFile) {
    writePrivateAtomic(readyFile, JSON.stringify(ready, null, 2));
  }
  console.log(JSON.stringify(ready));
  console.error("Warning: captured OTLP .bin files are raw and may contain sensitive data; delete them after inspection.");
});

function shutdown() {
  server.close(() => {
    try {
      fs.closeSync(lockHandle);
    } catch {}
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (lock.receiverId === receiverId) fs.unlinkSync(lockPath);
    } catch {}
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
