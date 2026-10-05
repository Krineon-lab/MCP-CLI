import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.join(root, "dist", "index.js");
const tempFile = path.join(root, ".rob-dc-smoke.tmp");

function asJson(result) {
  assert.equal(result.isError, undefined);
  const block = result.content.find((item) => item.type === "text");
  assert(block && block.type === "text");
  return JSON.parse(block.text);
}

const client = new Client({ name: "rob-dc-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    ROB_DC_ALLOWED_DIRS: root
  }
});

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  for (const required of ["rob_status", "fs_read", "fs_write", "fs_patch", "search", "exec", "process_read"]) {
    assert(names.includes(required), `missing tool: ${required}`);
  }
  assert(names.length >= 14);

  asJson(await client.callTool({ name: "rob_status", arguments: {} }));

  const read = asJson(await client.callTool({
    name: "fs_read",
    arguments: { path: path.join(root, "package.json"), maxLines: 20 }
  }));
  assert.match(read.content, /rob-desktop-commander/);

  const search = asJson(await client.callTool({
    name: "search",
    arguments: { path: root, query: "Rob Desktop Commander", mode: "content", literal: true, maxResults: 20 }
  }));
  assert(search.count > 0);

  asJson(await client.callTool({
    name: "fs_write",
    arguments: { path: tempFile, content: "alpha\n", mode: "overwrite" }
  }));
  const patched = asJson(await client.callTool({
    name: "fs_patch",
    arguments: { path: tempFile, edits: [{ oldText: "alpha", newText: "beta", expected: 1 }] }
  }));
  assert.equal(patched.replacements, 1);
  const tempRead = asJson(await client.callTool({
    name: "fs_read",
    arguments: { path: tempFile }
  }));
  assert.match(tempRead.content, /beta/);

  const quick = asJson(await client.callTool({
    name: "exec",
    arguments: { command: "node --version", cwd: root, detachAfterMs: 2500, timeoutMs: 10000 }
  }));
  assert.equal(quick.detached, false);
  assert.match(quick.stdout, /^v\d+/);

  const slow = asJson(await client.callTool({
    name: "exec",
    arguments: {
      command: "node -e \"setTimeout(()=>console.log('late-ok'),200)\"",
      cwd: root,
      detachAfterMs: 10,
      timeoutMs: 10000
    }
  }));
  assert.equal(slow.detached, true);
  assert(slow.sessionId);

  const session = asJson(await client.callTool({
    name: "process_read",
    arguments: { sessionId: slow.sessionId, cursor: 0, waitMs: 2000 }
  }));
  const sessionText = session.events.map((event) => event.text).join("");
  assert.match(sessionText, /late-ok/);

  let finalSession = session;
  if (finalSession.running) {
    finalSession = asJson(await client.callTool({
      name: "process_read",
      arguments: { sessionId: slow.sessionId, cursor: session.cursor, waitMs: 2000 }
    }));
  }
  assert.equal(finalSession.running, false);

  asJson(await client.callTool({
    name: "fs_manage",
    arguments: { operation: "delete", path: tempFile, force: true }
  }));

  console.log(JSON.stringify({ ok: true, toolCount: names.length, tools: names }, null, 2));
} finally {
  await client.close();
}
