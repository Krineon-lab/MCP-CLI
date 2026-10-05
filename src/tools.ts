import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { config, SERVER_NAME, VERSION } from "./config.js";
import { assertAllowed, truncate } from "./security.js";
import { processes } from "./process-manager.js";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }]
  };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

async function safe(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

async function readLimited(file: string, maxBytes = config.maxReadBytes): Promise<{ buffer: Buffer; truncated: boolean; size: number }> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  const length = Math.min(stat.size, maxBytes);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { buffer: buffer.subarray(0, bytesRead), truncated: stat.size > bytesRead, size: stat.size };
  } finally {
    await handle.close();
  }
}

function sha256(buffer: Buffer | string): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileHash(file: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.rob-dc-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(temp, content, "utf8");
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function listTree(root: string, depth: number, maxEntries: number) {
  const items: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }> = [];
  async function walk(current: string, level: number): Promise<void> {
    if (items.length >= maxEntries || level > depth) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (items.length >= maxEntries) break;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute) || ".";
      const type = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other";
      items.push({ path: relative, type });
      if (entry.isDirectory() && level < depth) await walk(absolute, level + 1);
    }
  }
  await walk(root, 1);
  return { items, truncated: items.length >= maxEntries };
}

async function runRg(args: string[], cwd: string, maxChars = config.maxOutputChars): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  const { rgPath } = await import("@vscode/ripgrep");
  return await new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let wasTruncated = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxChars * 2) {
        wasTruncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxChars) stderr = stderr.slice(-maxChars);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const out = truncate(stdout, maxChars);
      resolve({ code: code ?? 0, stdout: out.text, stderr, truncated: wasTruncated || out.truncated });
    });
  });
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "rob_status",
    {
      description: "Show Rob Desktop Commander runtime, security scope and active process sessions.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => safe(async () => ({
      name: SERVER_NAME,
      version: VERSION,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      uptimeSeconds: Math.round(process.uptime()),
      defaultShell: config.defaultShell,
      allowedDirectories: config.allowedDirectories.length ? config.allowedDirectories : ["*"],
      dangerousCommandGuard: !config.allowDangerousCommands,
      defaults: {
        timeoutMs: config.defaultTimeoutMs,
        detachAfterMs: config.detachAfterMs,
        maxOutputChars: config.maxOutputChars,
        maxReadBytes: config.maxReadBytes
      },
      sessions: processes.list()
    }))
  );

  server.registerTool(
    "fs_read",
    {
      description: "Read one local file. Supports UTF-8 line slicing or base64 for binary files. Prefer fs_read_many when several files are needed.",
      inputSchema: z.object({
        path: z.string().min(1),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        offsetLine: z.number().int().min(1).default(1),
        maxLines: z.number().int().min(1).max(10000).default(1000),
        maxBytes: z.number().int().min(1).max(20_000_000).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ path: input, encoding, offsetLine, maxLines, maxBytes }) => safe(async () => {
      const file = await assertAllowed(input);
      const data = await readLimited(file, maxBytes ?? config.maxReadBytes);
      if (encoding === "base64") {
        return { path: file, encoding, size: data.size, truncated: data.truncated, content: data.buffer.toString("base64") };
      }
      const text = data.buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      const start = offsetLine - 1;
      const selected = lines.slice(start, start + maxLines);
      return {
        path: file,
        encoding,
        size: data.size,
        sha256: data.truncated ? null : sha256(data.buffer),
        loadedSha256: sha256(data.buffer),
        offsetLine,
        returnedLines: selected.length,
        totalLoadedLines: lines.length,
        truncatedByBytes: data.truncated,
        hasMoreLines: start + selected.length < lines.length || data.truncated,
        content: selected.join("\n")
      };
    })
  );

  server.registerTool(
    "fs_read_many",
    {
      description: "Read multiple UTF-8 files in one MCP call. Use this instead of repeated fs_read calls when gathering project context.",
      inputSchema: z.object({
        paths: z.array(z.string().min(1)).min(1).max(64),
        maxBytesEach: z.number().int().min(1).max(2_000_000).default(256_000)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ paths, maxBytesEach }) => safe(async () => {
      const results = await Promise.all(paths.map(async (input) => {
        try {
          const file = await assertAllowed(input);
          const data = await readLimited(file, maxBytesEach);
          return { path: file, size: data.size, truncated: data.truncated, content: data.buffer.toString("utf8") };
        } catch (error) {
          return { path: input, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      return { files: results };
    })
  );

  server.registerTool(
    "fs_write",
    {
      description: "Create, overwrite or append a UTF-8 file. Overwrites are atomic by default and can use expectedSha256 as an optimistic concurrency guard.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
        mode: z.enum(["overwrite", "append"]).default("overwrite"),
        createParents: z.boolean().default(true),
        atomic: z.boolean().default(true),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ path: input, content, mode, createParents, atomic, expectedSha256 }) => safe(async () => {
      const file = await assertAllowed(input, true);
      if (createParents) await fs.mkdir(path.dirname(file), { recursive: true });
      const before = await fileHash(file);
      if (expectedSha256 && before?.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(`SHA-256 precondition failed. Expected ${expectedSha256}, actual ${before ?? "<missing>"}`);
      }
      if (mode === "append") {
        await fs.appendFile(file, content, "utf8");
      } else if (atomic) {
        await atomicWrite(file, content);
      } else {
        await fs.writeFile(file, content, "utf8");
      }
      const after = await fileHash(file);
      return { path: file, mode, bytesWritten: Buffer.byteLength(content), sha256Before: before, sha256After: after };
    })
  );

  server.registerTool(
    "fs_patch",
    {
      description: "Apply one or more exact text replacements to a file in memory, validate expected match counts, then write once atomically.",
      inputSchema: z.object({
        path: z.string().min(1),
        edits: z.array(z.object({
          oldText: z.string().min(1),
          newText: z.string(),
          expected: z.number().int().min(1).max(1000).default(1)
        })).min(1).max(100),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ path: input, edits, expectedSha256 }) => safe(async () => {
      const file = await assertAllowed(input, true);
      const stat = await fs.stat(file);
      if (stat.size > config.maxReadBytes) throw new Error(`File exceeds fs_patch safety limit of ${config.maxReadBytes} bytes`);
      const originalBuffer = await fs.readFile(file);
      const beforeHash = sha256(originalBuffer);
      if (expectedSha256 && beforeHash.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(`SHA-256 precondition failed. Expected ${expectedSha256}, actual ${beforeHash}`);
      }
      let text = originalBuffer.toString("utf8");
      const applied: Array<{ expected: number; matches: number }> = [];
      for (const edit of edits) {
        const matches = text.split(edit.oldText).length - 1;
        if (matches !== edit.expected) {
          throw new Error(`Patch precondition failed: expected ${edit.expected} match(es), found ${matches}`);
        }
        text = text.split(edit.oldText).join(edit.newText);
        applied.push({ expected: edit.expected, matches });
      }
      await atomicWrite(file, text);
      return { path: file, editsApplied: applied.length, replacements: applied.reduce((n, x) => n + x.matches, 0), sha256Before: beforeHash, sha256After: sha256(text) };
    })
  );

  server.registerTool(
    "fs_list",
    {
      description: "List a directory tree with bounded recursion and result count.",
      inputSchema: z.object({
        path: z.string().min(1),
        depth: z.number().int().min(1).max(20).default(2),
        maxEntries: z.number().int().min(1).max(10000).default(1000)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ path: input, depth, maxEntries }) => safe(async () => {
      const root = await assertAllowed(input);
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
      return { root, ...(await listTree(root, depth, maxEntries)) };
    })
  );

  server.registerTool(
    "fs_manage",
    {
      description: "Perform filesystem management in one tool: stat, mkdir, move, copy or delete. destination is required for move/copy.",
      inputSchema: z.object({
        operation: z.enum(["stat", "mkdir", "move", "copy", "delete"]),
        path: z.string().min(1),
        destination: z.string().min(1).optional(),
        recursive: z.boolean().default(false),
        force: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ operation, path: input, destination, recursive, force }) => safe(async () => {
      const source = await assertAllowed(input, operation !== "stat");
      if (operation === "stat") {
        const s = await fs.stat(source);
        return {
          path: source,
          type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
          size: s.size,
          createdAt: s.birthtime.toISOString(),
          modifiedAt: s.mtime.toISOString(),
          sha256: s.isFile() && s.size <= config.maxReadBytes ? await fileHash(source) : undefined
        };
      }
      if (operation === "mkdir") {
        await fs.mkdir(source, { recursive: true });
        return { operation, path: source };
      }
      if (operation === "delete") {
        await fs.rm(source, { recursive, force });
        return { operation, path: source, recursive, force };
      }
      if (!destination) throw new Error("destination is required for move/copy");
      const target = await assertAllowed(destination, true);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (operation === "copy") {
        await fs.cp(source, target, { recursive, force });
      } else {
        try {
          await fs.rename(source, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await fs.cp(source, target, { recursive: true, force: true });
          await fs.rm(source, { recursive: true, force: true });
        }
      }
      return { operation, path: source, destination: target };
    })
  );

  server.registerTool(
    "search",
    {
      description: "Fast local search powered by ripgrep. mode=content searches text with line/column output; mode=name searches file paths.",
      inputSchema: z.object({
        path: z.string().min(1),
        query: z.string(),
        mode: z.enum(["content", "name"]).default("content"),
        glob: z.string().optional(),
        literal: z.boolean().default(false),
        ignoreCase: z.boolean().default(true),
        includeHidden: z.boolean().default(false),
        maxResults: z.number().int().min(1).max(10000).default(200)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ path: input, query, mode, glob, literal, ignoreCase, includeHidden, maxResults }) => safe(async () => {
      const root = await assertAllowed(input);
      if (mode === "name") {
        const args = ["--files", "--color", "never"];
        if (includeHidden) args.push("--hidden");
        if (glob) args.push("-g", glob);
        const result = await runRg(args, root);
        if (result.code > 1) throw new Error(result.stderr || `ripgrep failed with exit code ${result.code}`);
        const all = result.stdout.split(/\r?\n/).filter(Boolean);
        let matcher: (value: string) => boolean;
        if (literal) {
          const needle = ignoreCase ? query.toLowerCase() : query;
          matcher = (value) => (ignoreCase ? value.toLowerCase() : value).includes(needle);
        } else {
          const re = new RegExp(query, ignoreCase ? "i" : undefined);
          matcher = (value) => re.test(value);
        }
        const filtered = all.filter(matcher);
        const matches = filtered.slice(0, Math.min(maxResults, config.maxSearchResults));
        return { root, mode, query, count: matches.length, truncated: matches.length < filtered.length, matches };
      }

      const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
      if (includeHidden) args.push("--hidden");
      if (ignoreCase) args.push("-i");
      if (literal) args.push("-F");
      if (glob) args.push("-g", glob);
      args.push("--", query, ".");
      const result = await runRg(args, root);
      if (result.code > 1) throw new Error(result.stderr || `ripgrep failed with exit code ${result.code}`);
      const limit = Math.min(maxResults, config.maxSearchResults);
      const lines = result.stdout.split(/\r?\n/).filter(Boolean);
      return { root, mode, query, count: Math.min(lines.length, limit), truncated: result.truncated || lines.length > limit, matches: lines.slice(0, limit) };
    })
  );

  server.registerTool(
    "exec",
    {
      description: "Run a shell command efficiently. If it finishes before detachAfterMs, stdout/stderr and exit code are returned in this same MCP call. If still running, it automatically becomes a persistent session and returns sessionId.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        shell: z.string().optional(),
        detachAfterMs: z.number().int().min(0).max(30000).optional(),
        timeoutMs: z.number().int().min(100).max(600000).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ command, cwd, shell, detachAfterMs, timeoutMs }) => safe(async () =>
      await processes.exec(command, { cwd, shell, detachAfterMs, timeoutMs })
    )
  );

  server.registerTool(
    "process_start",
    {
      description: "Start a long-running or interactive command immediately and return a sessionId without waiting.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        shell: z.string().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ command, cwd, shell }) => safe(async () => {
      const session = await processes.start(command, cwd, shell);
      return { sessionId: session.id, pid: session.child.pid, command: session.command, cwd: session.cwd };
    })
  );

  server.registerTool(
    "process_read",
    {
      description: "Read new output events from a persistent process session. Omit cursor for incremental reads; provide cursor for explicit replay position.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        cursor: z.number().int().min(0).optional(),
        waitMs: z.number().int().min(0).max(10000).default(0)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ sessionId, cursor, waitMs }) => safe(async () => {
      let result = processes.read(sessionId, cursor);
      if (waitMs > 0 && result.running && result.events.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        result = processes.read(sessionId, cursor);
      }
      return result;
    })
  );

  server.registerTool(
    "process_input",
    {
      description: "Send input to an interactive persistent process session.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        input: z.string(),
        newline: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ sessionId, input, newline }) => safe(async () => {
      processes.input(sessionId, input, newline);
      return { sessionId, writtenChars: input.length, newline };
    })
  );

  server.registerTool(
    "process_kill",
    {
      description: "Terminate a persistent process session, including its child process tree on Windows.",
      inputSchema: z.object({ sessionId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ sessionId }) => safe(async () => {
      await processes.kill(sessionId);
      return { sessionId, killed: true };
    })
  );

  server.registerTool(
    "process_list",
    {
      description: "List active and recently completed persistent process sessions.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => safe(async () => ({ sessions: processes.list() }))
  );
}
