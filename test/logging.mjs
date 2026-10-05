import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist", "index.js");
const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "rob-dc-logs-"));

function asJson(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const block = result.content.find((item) => item.type === "text");
  assert(block && block.type === "text");
  return JSON.parse(block.text);
}

const client = new Client({ name: "rob-dc-logging-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    ROB_DC_ALLOWED_DIRS: root,
    ROB_DC_LOG_ENABLED: "1",
    ROB_DC_LOG_LEVEL: "debug",
    ROB_DC_LOG_DIR: logDir,
    ROB_DC_LOG_FLUSH_MS: "25"
  }
});

try {
  await client.connect(transport);

  const initial = asJson(await client.callTool({
    name: "rob_logging",
    arguments: { action: "status" }
  }));
  assert.equal(initial.enabled, true);

  asJson(await client.callTool({
    name: "exec",
    arguments: { command: "node --version", cwd: root, detachAfterMs: 10000, timeoutMs: 20000 }
  }));

  asJson(await client.callTool({ name: "rob_logging", arguments: { action: "flush" } }));
  const disabled = asJson(await client.callTool({ name: "rob_logging", arguments: { action: "disable" } }));
  assert.equal(disabled.enabled, false);
} finally {
  await client.close();
}

const files = (await fs.readdir(logDir)).filter((name) => name.endsWith(".jsonl"));
assert(files.length >= 1, "expected at least one JSONL debug log");

const events = [];
for (const file of files) {
  const content = await fs.readFile(path.join(logDir, file), "utf8");
  for (const line of content.split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line));
}

assert(events.some((entry) => entry.event === "tool.start"));
assert(events.some((entry) => entry.event === "tool.end"));
assert(events.some((entry) => entry.event === "process.started"));
assert(events.some((entry) => entry.event === "process.closed"));

console.log(JSON.stringify({ ok: true, logFiles: files.length, events: events.length }, null, 2));
await fs.rm(logDir, { recursive: true, force: true });
