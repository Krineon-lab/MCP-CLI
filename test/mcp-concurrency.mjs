import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist", "index.js");
const projectA = path.join(root, ".rob-dc-concurrency-a");
const projectB = path.join(root, ".rob-dc-concurrency-b");

function asJson(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const block = result.content.find((item) => item.type === "text");
  assert(block && block.type === "text");
  return JSON.parse(block.text);
}

await fs.mkdir(path.join(projectA, ".git"), { recursive: true });
await fs.mkdir(path.join(projectB, ".git"), { recursive: true });

const client = new Client({ name: "rob-dc-concurrency-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    ROB_DC_ALLOWED_DIRS: root,
    ROB_DC_MAX_PROCESSES: "2",
    ROB_DC_MAX_PROCESSES_PER_WORKSPACE: "1",
    ROB_DC_QUEUE_TIMEOUT_MS: "10000"
  }
});

try {
  await client.connect(transport);
  const command = `node -e "setTimeout(()=>process.exit(0),300)"`;
  const started = Date.now();
  const results = await Promise.all([
    client.callTool({ name: "exec", arguments: { command, cwd: projectA, detachAfterMs: 5000, timeoutMs: 10000 } }),
    client.callTool({ name: "exec", arguments: { command, cwd: projectA, detachAfterMs: 5000, timeoutMs: 10000 } }),
    client.callTool({ name: "exec", arguments: { command, cwd: projectB, detachAfterMs: 5000, timeoutMs: 10000 } }),
    client.callTool({ name: "exec", arguments: { command, cwd: projectB, detachAfterMs: 5000, timeoutMs: 10000 } })
  ]);
  const elapsedMs = Date.now() - started;
  const parsed = results.map(asJson);

  assert(parsed.every((result) => result.detached === false));
  assert.equal(new Set(parsed.map((result) => result.workspace)).size, 2);
  const waits = parsed.map((result) => result.queueWaitMs);
  assert(Math.max(...waits) >= 100, `expected queued calls, got queue waits: ${waits.join(", ")}`);

  const status = asJson(await client.callTool({ name: "rob_status", arguments: {} }));
  assert.equal(status.concurrency.processes.maxGlobal, 2);
  assert.equal(status.concurrency.processes.maxPerWorkspace, 1);

  console.log(JSON.stringify({
    ok: true,
    elapsedMs,
    queueWaitMs: waits,
    workspaces: [...new Set(parsed.map((result) => result.workspace))]
  }, null, 2));
} finally {
  await client.close();
  await fs.rm(projectA, { recursive: true, force: true });
  await fs.rm(projectB, { recursive: true, force: true });
}
