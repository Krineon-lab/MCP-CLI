import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist", "index.js");
const tempDir = path.join(root, ".rob-dc-smoke-dir");
const tempA = path.join(tempDir, "a.txt");
const tempB = path.join(tempDir, "b.txt");

function asJson(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const block = result.content.find((item) => item.type === "text");
  assert(block && block.type === "text");
  return JSON.parse(block.text);
}

const client = new Client({ name: "rob-dc-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: { ...process.env, ROB_DC_ALLOWED_DIRS: root }
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  const expected = [
    "rob_status", "rob_logging", "fs_read", "fs_read_many", "fs_write", "fs_write_many",
    "fs_patch", "fs_list", "fs_manage", "search", "workspace_inspect", "exec", "exec_batch", "process"
  ];
  for (const required of expected) assert(names.includes(required), `missing tool: ${required}`);
  assert.equal(names.length, expected.length);

  const status = asJson(await client.callTool({
    name: "rob_status",
    arguments: { includeSessions: false, includeMetrics: true }
  }));
  assert.equal(status.version, "0.3.1");
  assert(status.logging);
  assert(status.metrics);

  const read = asJson(await client.callTool({
    name: "fs_read",
    arguments: { path: path.join(root, "package.json"), maxLines: 20 }
  }));
  assert.match(read.content, /rob-desktop-commander/);

  const writes = asJson(await client.callTool({
    name: "fs_write_many",
    arguments: {
      files: [
        { path: tempA, content: "one\ntwo\nthree\nfour\n", mode: "overwrite", returnSha256: true },
        { path: tempB, content: "alpha\nbeta\n", mode: "overwrite" }
      ]
    }
  }));
  assert.equal(writes.files.length, 2);
  assert.match(writes.files[0].sha256After, /^[a-f0-9]{64}$/);

  const tail = asJson(await client.callTool({
    name: "fs_read",
    arguments: { path: tempA, tailLines: 2 }
  }));
  assert.equal(tail.content, "three\nfour");

  const patched = asJson(await client.callTool({
    name: "fs_patch",
    arguments: {
      files: [
        { path: tempA, edits: [{ oldText: "three", newText: "THREE", expected: 1 }] },
        { path: tempB, edits: [{ oldText: "alpha", newText: "ALPHA", expected: 1 }] }
      ]
    }
  }));
  assert.equal(patched.files.length, 2);
  assert(patched.files.every((item) => item.replacements === 1));

  const many = asJson(await client.callTool({
    name: "fs_read_many",
    arguments: { paths: [tempA, tempB], maxBytesEach: 1000 }
  }));
  assert.equal(many.files.length, 2);

  const search = asJson(await client.callTool({
    name: "search",
    arguments: { path: root, query: "Rob Desktop Commander", mode: "content", literal: true, maxResults: 20 }
  }));
  assert(search.count > 0);

  const singleFileSearch = asJson(await client.callTool({
    name: "search",
    arguments: { path: path.join(root, "README.md"), query: "Rob Desktop Commander", mode: "content", literal: true, maxResults: 20 }
  }));
  assert(singleFileSearch.count > 0);
  assert.equal(singleFileSearch.target, "README.md");

  const inspect = asJson(await client.callTool({
    name: "workspace_inspect",
    arguments: { path: root, maxEntries: 50 }
  }));
  assert.equal(inspect.workspace.toLowerCase(), root.toLowerCase());
  assert(inspect.manifests.includes("package.json"));
  assert(inspect.git);

  const quick = asJson(await client.callTool({
    name: "exec",
    arguments: { command: "node --version", cwd: root, detachAfterMs: 10000, timeoutMs: 20000 }
  }));
  assert.equal(quick.detached, false);
  assert.match(quick.stdout, /^v\d+/);

  const drainStarted = Date.now();
  const drainTimeout = asJson(await client.callTool({
    name: "exec",
    arguments: {
      command: "node -e \"const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit'}); c.unref();\"",
      cwd: root,
      detachAfterMs: 3000,
      timeoutMs: 300
    }
  }));
  const drainDuration = Date.now() - drainStarted;
  assert.equal(drainTimeout.detached, false);
  assert(drainDuration < 1500, `exited root held inherited pipes too long: ${drainDuration}ms`);

  const hardTimeoutStarted = Date.now();
  const hardTimeout = asJson(await client.callTool({
    name: "exec",
    arguments: {
      command: "node -e \"setTimeout(()=>{},5000)\"",
      cwd: root,
      detachAfterMs: 3000,
      timeoutMs: 300
    }
  }));
  const hardTimeoutDuration = Date.now() - hardTimeoutStarted;
  assert.equal(hardTimeout.detached, false);
  assert.equal(hardTimeout.timedOut, true);
  assert(hardTimeoutDuration < 2000, `hard timeout took too long: ${hardTimeoutDuration}ms`);

  const batch = asJson(await client.callTool({
    name: "exec_batch",
    arguments: {
      parallel: true,
      commands: [
        { command: "node -e \"console.log('batch-a')\"", cwd: root, detachAfterMs: 10000 },
        { command: "node -e \"console.log('batch-b')\"", cwd: root, detachAfterMs: 10000 }
      ]
    }
  }));
  assert.equal(batch.results.length, 2);
  assert(batch.results.every((item) => item.exitCode === 0));

  const started = asJson(await client.callTool({
    name: "process",
    arguments: {
      action: "start",
      command: "node -e \"setTimeout(()=>console.log('late-ok'),200)\"",
      cwd: root
    }
  }));
  assert(started.sessionId);

  const waitStarted = Date.now();
  const session = asJson(await client.callTool({
    name: "process",
    arguments: { action: "read", sessionId: started.sessionId, cursor: 0, waitMs: 2000 }
  }));
  const waitDuration = Date.now() - waitStarted;
  assert(waitDuration < 1500, `event-driven read waited too long: ${waitDuration}ms`);
  assert.match(session.events.map((event) => event.text).join(""), /late-ok/);

  asJson(await client.callTool({
    name: "fs_manage",
    arguments: { operation: "delete", path: tempDir, recursive: true, force: true }
  }));

  console.log(JSON.stringify({ ok: true, toolCount: names.length, eventDrivenWaitMs: waitDuration, tools: names }, null, 2));
} finally {
  await client.close();
}