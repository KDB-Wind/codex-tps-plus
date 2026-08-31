import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function canonicalPath(value) {
  if (!value) return "";
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isDirectRun(moduleUrl, invokedPath = process.argv[1]) {
  return canonicalPath(invokedPath) === canonicalPath(fileURLToPath(moduleUrl));
}
