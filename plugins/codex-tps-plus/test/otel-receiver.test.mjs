import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectOtelCapture } from "../scripts/otel-inspect.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function waitForJson(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function post(port, body, requestPath = "/v1/logs") {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("OTel receiver atomically stores bounded raw captures", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-otel-"));
  const readyFile = path.join(temp, "ready.json");
  const child = spawn(
    process.execPath,
    [
      path.join(root, "scripts", "otel.mjs"),
      "serve",
      "--output-dir",
      temp,
      "--ready-file",
      readyFile,
      "--max-body-bytes",
      "32",
      "--max-files",
      "1",
    ],
    { stdio: "ignore" }
  );
  try {
    const ready = await waitForJson(readyFile);
    assert.match(ready.receiverId, /^[0-9a-f]{32}$/);
    assert.equal(ready.endpoint, `http://127.0.0.1:${ready.port}`);
    assert.equal(await post(ready.port, Buffer.alloc(64, 1)), 413);
    assert.equal(await post(ready.port, Buffer.from("small raw body"), "/v1/logs?secret=query-value"), 200);
    assert.equal(await post(ready.port, Buffer.from("new raw body"), "/v1/metrics"), 200);
    const bodyFiles = fs.readdirSync(temp).filter((name) => name.endsWith(".bin"));
    const metaFiles = fs.readdirSync(temp).filter((name) => name.endsWith(".meta.json"));
    assert.equal(bodyFiles.length, 1);
    assert.equal(metaFiles.length, 1);
    const metadata = JSON.parse(fs.readFileSync(path.join(temp, metaFiles[0]), "utf8"));
    assert.equal(metadata.rawCaptureSensitive, true);
    assert.equal(metadata.receiverId, ready.receiverId);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.contentLength, 12);
    assert.equal(metadata.url, "/v1/metrics");
    assert.equal(JSON.stringify(metadata).includes("query-value"), false);
    assert.equal(fs.readdirSync(temp).some((name) => name.endsWith(".tmp")), false);
    const liveInspection = inspectOtelCapture(temp);
    assert.equal(liveInspection.receiver.active, true);
    assert.equal(liveInspection.receiver.exclusiveCaptureWriter, true);
    assert.equal(liveInspection.receiver.endpoint, ready.endpoint);
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    assert.equal(inspectOtelCapture(temp).receiver.active, false);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("OTel receiver refuses a competing writer for the same capture directory", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tps-plus-otel-lock-"));
  const readyFile = path.join(temp, "ready.json");
  const args = [
    path.join(root, "scripts", "otel.mjs"),
    "serve",
    "--output-dir",
    temp,
    "--ready-file",
    readyFile,
  ];
  const first = spawn(process.execPath, args, { stdio: "ignore" });
  try {
    await waitForJson(readyFile);
    const second = spawn(process.execPath, args, { stdio: "ignore" });
    const [code] = await once(second, "exit");
    assert.notEqual(code, 0);
  } finally {
    first.kill();
    await Promise.race([once(first, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
