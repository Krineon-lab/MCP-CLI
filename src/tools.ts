import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { config, SERVER_NAME, VERSION } from "./config.js";
import { assertAllowed } from "./security.js";
import { processes } from "./process-manager.js";
import { concurrencySnapshot, fileLocks, ioPool, searchPool } from "./resource-manager.js";
import { workspaceForPath, workspaceCacheSize } from "./workspace.js";
import { logger } from "./logger.js";
import { metrics } from "./metrics.js";
import {
  atomicWrite,
  countOccurrences,
  hashFile,
  listTree,
  readBinaryPrefix,
  readTailLines,
  readTextRange,
  sha256
} from "./fs-ops.js";
import { searchContent, searchNames } from "./search-engine.js";

type WriteRequest = {
  path: string;
  content: string;
  mode: "overwrite" | "append";
  createParents: boolean;
  atomic: boolean;
  expectedSha256?: string;
  returnSha256: boolean;
};

type ExactEdit = {
  oldText: string;
  newText: string;
  expected: number;
};

type PatchRequest = {
  path: string;
  edits: ExactEdit[];
  expectedSha256?: string;
};

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

function extractQueueWait(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, extractQueueWait(item)), 0);
  const record = value as Record<string, unknown>;
  let max = typeof record.queueWaitMs === "number" ? record.queueWaitMs : 0;
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") max = Math.max(max, extractQueueWait(child));
  }
  return max;
}

async function runTool(name: string, args: unknown, fn: () => Promise<unknown>) {
  const started = performance.now();
  logger.debug("tool.start", { tool: name, args });
  try {
    const result = await fn();
    const durationMs = performance.now() - started;
    const queueWaitMs = extractQueueWait(result);
    metrics.record(name, durationMs, false, queueWaitMs);
    logger.debug("tool.end", { tool: name, durationMs, queueWaitMs, ok: true });
    return ok(result);
  } catch (error) {
    const durationMs = performance.now() - started;
    metrics.record(name, durationMs, true, 0);
    logger.error("tool.error", {
      tool: name,
      durationMs,
      message: error instanceof Error ? error.message : String(error)
    });
    return fail(error);
  }
}

async function runIo<T>(
  targetPath: string,
  fn: (workspace: string, queueWaitMs: number) => Promise<T>
): Promise<T> {
  const workspace = await workspaceForPath(targetPath);
  return await ioPool.run(workspace, (queueWaitMs) => fn(workspace, queueWaitMs), config.queueTimeoutMs);
}

async function runSearch<T>(
  targetPath: string,
  fn: (workspace: string, queueWaitMs: number) => Promise<T>
): Promise<T> {
  const workspace = await workspaceForPath(targetPath);
  return await searchPool.run(workspace, (queueWaitMs) => fn(workspace, queueWaitMs), config.queueTimeoutMs);
}

async function writeOne(request: WriteRequest) {
  const file = await assertAllowed(request.path, true);
  return await fileLocks.withKeys([file], async () =>
    await runIo(file, async (workspace, queueWaitMs) => {
      if (request.createParents) await fs.mkdir(path.dirname(file), { recursive: true });

      let beforeHash: string | null | undefined;
      if (request.expectedSha256) {
        beforeHash = await hashFile(file);
        if (beforeHash?.toLowerCase() !== request.expectedSha256.toLowerCase()) {
          throw new Error(`SHA-256 precondition failed. Expected ${request.expectedSha256}, actual ${beforeHash ?? "<missing>"}`);
        }
      }

      if (request.mode === "append") {
        await fs.appendFile(file, request.content, "utf8");
      } else if (request.atomic) {
        await atomicWrite(file, request.content);
      } else {
        await fs.writeFile(file, request.content, "utf8");
      }

      let afterHash: string | null | undefined;
      if (request.returnSha256) {
        afterHash = request.mode === "overwrite" ? sha256(request.content) : await hashFile(file);
      }

      return {
        path: file,
        workspace,
        queueWaitMs,
        mode: request.mode,
        bytesWritten: Buffer.byteLength(request.content),
        ...(request.expectedSha256 ? { sha256Before: beforeHash } : {}),
        ...(request.returnSha256 ? { sha256After: afterHash } : {})
      };
    })
  );
}

async function patchOne(request: PatchRequest) {
  const file = await assertAllowed(request.path, true);
  return await fileLocks.withKeys([file], async () =>
    await runIo(file, async (workspace, queueWaitMs) => {
      const stat = await fs.stat(file);
      if (stat.size > config.maxReadBytes) {
        throw new Error(`File exceeds fs_patch safety limit of ${config.maxReadBytes} bytes`);
      }

      const originalBuffer = await fs.readFile(file);
      const beforeHash = sha256(originalBuffer);
      if (request.expectedSha256 && beforeHash.toLowerCase() !== request.expectedSha256.toLowerCase()) {
        throw new Error(`SHA-256 precondition failed. Expected ${request.expectedSha256}, actual ${beforeHash}`);
      }

      let text = originalBuffer.toString("utf8");
      let replacements = 0;
      for (const edit of request.edits) {
        const matches = countOccurrences(text, edit.oldText);
        if (matches !== edit.expected) {
          throw new Error(`Patch precondition failed: expected ${edit.expected} match(es), found ${matches}`);
        }
        text = text.replaceAll(edit.oldText, edit.newText);
        replacements += matches;
      }

      await atomicWrite(file, text);
      return {
        path: file,
        workspace,
        queueWaitMs,
        editsApplied: request.edits.length,
        replacements,
        sha256Before: beforeHash,
        sha256After: sha256(text)
      };
    })
  );
}

function normalizeGlobs(glob: string | undefined, globs: string[]): string[] {
  return [...new Set([...(glob ? [glob] : []), ...globs].filter(Boolean))].slice(0, 20);
}

function parseGitStatus(stdout: string) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let branch: string | null = null;
  let head: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changes: string[] = [];

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.oid ")) head = line.slice("# branch.oid ".length);
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (!line.startsWith("#")) {
      changes.push(line);
    }
  }

  return {
    branch,
    head,
    ahead,
    behind,
    dirty: changes.length > 0,
    changeCount: changes.length,
    changes: changes.slice(0, 100),
    changesTruncated: changes.length > 100
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "rob_status",
    {
      description: "Compact runtime diagnostics. Can optionally include session details and per-tool performance metrics.",
      inputSchema: z.object({
        includeSessions: z.boolean().default(false),
        includeMetrics: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("rob_status", args, async () => {
      const sessions = processes.list();
      return {
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
          queueTimeoutMs: config.queueTimeoutMs,
          maxQueueGlobal: config.maxQueueGlobal,
          maxQueuePerWorkspace: config.maxQueuePerWorkspace,
          sessionRetentionMs: config.sessionRetentionMs,
          maxOutputChars: config.maxOutputChars,
          maxReadBytes: config.maxReadBytes
        },
        logging: logger.status(),
        concurrency: concurrencySnapshot(),
        workspaceCacheEntries: workspaceCacheSize(),
        activeSessions: sessions.filter((session) => session.running).length,
        ...(args.includeSessions ? { sessions } : {}),
        ...(args.includeMetrics ? { metrics: metrics.snapshot() } : {})
      };
    })
  );

  server.registerTool(
    "rob_logging",
    {
      description: "Control detailed JSONL debug logging at runtime. Environment variables remain the startup defaults.",
      inputSchema: z.object({
        action: z.enum(["status", "enable", "disable", "flush", "set_level"]).default("status"),
        level: z.enum(["debug", "info", "warn", "error"]).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("rob_logging", args, async () => {
      if (args.action === "enable") {
        logger.setEnabled(true);
        logger.info("logging.enabled", { source: "tool" });
      } else if (args.action === "disable") {
        logger.info("logging.disabled", { source: "tool" });
        await logger.flush();
        logger.setEnabled(false);
      } else if (args.action === "flush") {
        await logger.flush();
      } else if (args.action === "set_level") {
        if (!args.level) throw new Error("level is required for action=set_level");
        logger.setLevel(args.level);
        logger.info("logging.level_changed", { level: args.level });
      }
      return logger.status();
    })
  );

  server.registerTool(
    "fs_read",
    {
      description: "Read one file efficiently: text line range, efficient tail, or base64 prefix. Hashing is opt-in to avoid unnecessary full-file reads.",
      inputSchema: z.object({
        path: z.string().min(1),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        offsetLine: z.number().int().min(1).default(1),
        maxLines: z.number().int().min(1).max(10000).default(1000),
        tailLines: z.number().int().min(1).max(10000).optional(),
        maxBytes: z.number().int().min(1).max(20_000_000).optional(),
        includeSha256: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("fs_read", args, async () => {
      const file = await assertAllowed(args.path);
      return await runIo(file, async (workspace, queueWaitMs) => {
        const maxBytes = args.maxBytes ?? config.maxReadBytes;
        const hashPromise = args.includeSha256 ? hashFile(file) : Promise.resolve(undefined);

        if (args.encoding === "base64") {
          const data = await readBinaryPrefix(file, maxBytes);
          return {
            path: file,
            workspace,
            queueWaitMs,
            encoding: "base64",
            size: data.size,
            truncated: data.truncated,
            ...(args.includeSha256 ? { sha256: await hashPromise } : {}),
            content: data.buffer.toString("base64")
          };
        }

        if (args.tailLines) {
          const data = await readTailLines(file, args.tailLines, maxBytes);
          return {
            path: file,
            workspace,
            queueWaitMs,
            encoding: "utf8",
            size: data.size,
            tailLines: args.tailLines,
            returnedLines: data.returnedLines,
            truncatedByBytes: data.truncatedByBytes,
            ...(args.includeSha256 ? { sha256: await hashPromise } : {}),
            content: data.content
          };
        }

        const data = await readTextRange(file, args.offsetLine, args.maxLines);
        return {
          path: file,
          workspace,
          queueWaitMs,
          encoding: "utf8",
          size: data.size,
          offsetLine: args.offsetLine,
          returnedLines: data.returnedLines,
          scannedLines: data.scannedLines,
          hasMoreLines: data.hasMoreLines,
          ...(args.includeSha256 ? { sha256: await hashPromise } : {}),
          content: data.content
        };
      });
    })
  );

  server.registerTool(
    "fs_read_many",
    {
      description: "Batch-read UTF-8 prefixes from multiple files in one MCP call. Work is concurrency-limited per workspace.",
      inputSchema: z.object({
        paths: z.array(z.string().min(1)).min(1).max(64),
        maxBytesEach: z.number().int().min(1).max(2_000_000).default(256_000)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("fs_read_many", args, async () => {
      const files = await Promise.all(args.paths.map(async (input) => {
        try {
          const file = await assertAllowed(input);
          return await runIo(file, async (workspace, queueWaitMs) => {
            const data = await readBinaryPrefix(file, args.maxBytesEach);
            return {
              path: file,
              workspace,
              queueWaitMs,
              size: data.size,
              truncated: data.truncated,
              content: data.buffer.toString("utf8")
            };
          });
        } catch (error) {
          return { path: input, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      return { files };
    })
  );

  const writeSchema = z.object({
    path: z.string().min(1),
    content: z.string(),
    mode: z.enum(["overwrite", "append"]).default("overwrite"),
    createParents: z.boolean().default(true),
    atomic: z.boolean().default(true),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    returnSha256: z.boolean().default(false)
  });

  server.registerTool(
    "fs_write",
    {
      description: "Write one UTF-8 file. No full-file hashing is performed unless expectedSha256 or returnSha256 is requested.",
      inputSchema: writeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => runTool("fs_write", args, async () => await writeOne(args))
  );

  server.registerTool(
    "fs_write_many",
    {
      description: "Create/update multiple independent files concurrently in one MCP call. Same-file operations remain serialized.",
      inputSchema: z.object({
        files: z.array(writeSchema).min(1).max(32)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => runTool("fs_write_many", args, async () => ({
      files: await Promise.all(args.files.map(async (request) => {
        try {
          return await writeOne(request);
        } catch (error) {
          return { path: request.path, error: error instanceof Error ? error.message : String(error) };
        }
      }))
    }))
  );

  const patchSchema = z.object({
    path: z.string().min(1),
    edits: z.array(z.object({
      oldText: z.string().min(1),
      newText: z.string(),
      expected: z.number().int().min(1).max(1000).default(1)
    })).min(1).max(100),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
  });

  server.registerTool(
    "fs_patch",
    {
      description: "Apply validated exact replacements to one file, or patch several independent files concurrently in one MCP call.",
      inputSchema: z.object({
        path: z.string().min(1).optional(),
        edits: z.array(z.object({
          oldText: z.string().min(1),
          newText: z.string(),
          expected: z.number().int().min(1).max(1000).default(1)
        })).min(1).max(100).optional(),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
        files: z.array(patchSchema).min(1).max(32).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => runTool("fs_patch", args, async () => {
      if (args.files) {
        if (args.path || args.edits) throw new Error("Use either files[] or path+edits, not both");
        return {
          files: await Promise.all(args.files.map(async (request) => {
            try {
              return await patchOne(request);
            } catch (error) {
              return { path: request.path, error: error instanceof Error ? error.message : String(error) };
            }
          }))
        };
      }

      if (!args.path || !args.edits) throw new Error("path and edits are required when files[] is not provided");
      return await patchOne({
        path: args.path,
        edits: args.edits,
        expectedSha256: args.expectedSha256
      });
    })
  );

  server.registerTool(
    "fs_list",
    {
      description: "Bounded directory tree listing. Common generated directories are excluded by default to reduce noise and I/O.",
      inputSchema: z.object({
        path: z.string().min(1),
        depth: z.number().int().min(1).max(20).default(2),
        maxEntries: z.number().int().min(1).max(10000).default(1000),
        excludeNames: z.array(z.string().min(1)).max(50).default([".git", "node_modules", "dist", ".next", "target", "__pycache__", ".venv"])
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("fs_list", args, async () => {
      const root = await assertAllowed(args.path);
      return await runIo(root, async (workspace, queueWaitMs) => {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
        return {
          root,
          workspace,
          queueWaitMs,
          ...(await listTree(root, args.depth, args.maxEntries, new Set(args.excludeNames)))
        };
      });
    })
  );

  server.registerTool(
    "fs_manage",
    {
      description: "Filesystem management in one tool: stat, mkdir, move, copy or delete. File hashing for stat is opt-in.",
      inputSchema: z.object({
        operation: z.enum(["stat", "mkdir", "move", "copy", "delete"]),
        path: z.string().min(1),
        destination: z.string().min(1).optional(),
        recursive: z.boolean().default(false),
        force: z.boolean().default(false),
        includeSha256: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => runTool("fs_manage", args, async () => {
      const source = await assertAllowed(args.path, args.operation !== "stat");
      if (args.operation === "stat") {
        return await runIo(source, async (workspace, queueWaitMs) => {
          const stat = await fs.stat(source);
          return {
            path: source,
            workspace,
            queueWaitMs,
            type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
            ...(args.includeSha256 && stat.isFile() ? { sha256: await hashFile(source) } : {})
          };
        });
      }

      const target = args.destination ? await assertAllowed(args.destination, true) : undefined;
      const lockKeys = target ? [source, target] : [source];
      return await fileLocks.withKeys(lockKeys, async () =>
        await runIo(source, async (workspace, queueWaitMs) => {
          if (args.operation === "mkdir") {
            await fs.mkdir(source, { recursive: true });
            return { operation: args.operation, path: source, workspace, queueWaitMs };
          }
          if (args.operation === "delete") {
            await fs.rm(source, { recursive: args.recursive, force: args.force });
            return { operation: args.operation, path: source, workspace, queueWaitMs };
          }
          if (!target) throw new Error("destination is required for move/copy");

          await fs.mkdir(path.dirname(target), { recursive: true });
          if (args.operation === "copy") {
            await fs.cp(source, target, { recursive: args.recursive, force: args.force });
          } else {
            try {
              await fs.rename(source, target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
              await fs.cp(source, target, { recursive: true, force: true });
              await fs.rm(source, { recursive: true, force: true });
            }
          }
          return { operation: args.operation, path: source, destination: target, workspace, queueWaitMs };
        })
      );
    })
  );

  server.registerTool(
    "search",
    {
      description: "Streaming ripgrep search that stops once enough results are collected instead of buffering an entire repository.",
      inputSchema: z.object({
        path: z.string().min(1),
        query: z.string().min(1),
        mode: z.enum(["content", "name", "files"]).default("content"),
        glob: z.string().optional(),
        globs: z.array(z.string().min(1)).max(20).default([]),
        literal: z.boolean().default(false),
        ignoreCase: z.boolean().default(true),
        includeHidden: z.boolean().default(false),
        maxResults: z.number().int().min(1).max(10000).default(200)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("search", args, async () => {
      const root = await assertAllowed(args.path);
      return await runSearch(root, async (workspace, queueWaitMs) => {
        const limit = Math.min(args.maxResults, config.maxSearchResults);
        const globs = normalizeGlobs(args.glob, args.globs);
        const result = args.mode === "name"
          ? await searchNames({
              cwd: root,
              query: args.query,
              literal: args.literal,
              ignoreCase: args.ignoreCase,
              includeHidden: args.includeHidden,
              globs,
              maxResults: limit,
              maxChars: config.maxOutputChars
            })
          : await searchContent({
              cwd: root,
              query: args.query,
              literal: args.literal,
              ignoreCase: args.ignoreCase,
              includeHidden: args.includeHidden,
              globs,
              maxResults: limit,
              maxChars: config.maxOutputChars,
              filesOnly: args.mode === "files"
            });

        if (result.code > 1) throw new Error(result.stderr || `ripgrep failed with exit code ${result.code}`);
        return {
          root,
          workspace,
          queueWaitMs,
          mode: args.mode,
          query: args.query,
          count: result.matches.length,
          truncated: result.truncated,
          matches: result.matches,
          ...(result.stderr ? { stderr: result.stderr } : {})
        };
      });
    })
  );

  server.registerTool(
    "workspace_inspect",
    {
      description: "One-call project inspection: detected workspace root, Git status, manifests/package metadata and compact top-level listing.",
      inputSchema: z.object({
        path: z.string().min(1),
        maxEntries: z.number().int().min(1).max(500).default(100),
        includeGit: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => runTool("workspace_inspect", args, async () => {
      const input = await assertAllowed(args.path);
      const workspace = await workspaceForPath(input);
      const io = await runIo(workspace, async (_workspace, queueWaitMs) => {
        const allEntries = await fs.readdir(workspace, { withFileTypes: true });
        const manifestNames = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "mix.exs", "deno.json", "deno.jsonc"];
        const allNames = new Set(allEntries.map((entry) => entry.name));
        const manifests = manifestNames.filter((name) => allNames.has(name));

        const entries = allEntries
          .filter((entry) => ![".git", "node_modules", "dist", ".next", "target", "__pycache__", ".venv"].includes(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, args.maxEntries)
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
          }));

        let packageJson: unknown;
        if (manifests.includes("package.json")) {
          try {
            const parsed = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8"));
            packageJson = {
              name: parsed.name,
              version: parsed.version,
              private: parsed.private,
              scripts: parsed.scripts ? Object.keys(parsed.scripts) : [],
              packageManager: parsed.packageManager
            };
          } catch {
            packageJson = { error: "package.json could not be parsed" };
          }
        }

        return { queueWaitMs, entries, manifests, packageJson };
      });

      let git: unknown = null;
      if (args.includeGit) {
        try {
          await fs.access(path.join(workspace, ".git"));
          const result = await processes.exec("git status --porcelain=v2 --branch", {
            cwd: workspace,
            detachAfterMs: 14_000,
            timeoutMs: 15_000
          });
          if (result.detached) {
            if (result.sessionId) await processes.kill(result.sessionId);
            git = { error: "git status exceeded 14 seconds and was terminated" };
          } else if (result.exitCode !== 0) {
            git = { error: result.stderr || `git status exited ${result.exitCode}` };
          } else {
            git = parseGitStatus(result.stdout);
          }
        } catch (error) {
          git = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      return {
        requestedPath: input,
        workspace,
        queueWaitMs: io.queueWaitMs,
        git,
        manifests: io.manifests,
        packageJson: io.packageJson,
        topLevel: io.entries
      };
    })
  );

  server.registerTool(
    "exec",
    {
      description: "Run one shell command. Short commands return directly; longer commands automatically become persistent sessions.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        shell: z.string().optional(),
        detachAfterMs: z.number().int().min(0).max(30000).optional(),
        timeoutMs: z.number().int().min(100).max(600000).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args) => runTool("exec", args, async () =>
      await processes.exec(args.command, {
        cwd: args.cwd,
        shell: args.shell,
        detachAfterMs: args.detachAfterMs,
        timeoutMs: args.timeoutMs
      })
    )
  );

  const execItemSchema = z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    shell: z.string().optional(),
    detachAfterMs: z.number().int().min(0).max(30000).optional(),
    timeoutMs: z.number().int().min(100).max(600000).optional()
  });

  server.registerTool(
    "exec_batch",
    {
      description: "Run several independent commands in one MCP call, in parallel or sequentially. Each command still obeys fair per-workspace process limits.",
      inputSchema: z.object({
        commands: z.array(execItemSchema).min(1).max(12),
        parallel: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args) => runTool("exec_batch", args, async () => {
      const runOne = async (item: z.infer<typeof execItemSchema>, index: number) => {
        try {
          return {
            index,
            ...(await processes.exec(item.command, {
              cwd: item.cwd,
              shell: item.shell,
              detachAfterMs: item.detachAfterMs,
              timeoutMs: item.timeoutMs
            }))
          };
        } catch (error) {
          return { index, error: error instanceof Error ? error.message : String(error) };
        }
      };

      if (args.parallel) {
        return { parallel: true, results: await Promise.all(args.commands.map(runOne)) };
      }

      const results = [];
      for (let i = 0; i < args.commands.length; i++) results.push(await runOne(args.commands[i], i));
      return { parallel: false, results };
    })
  );

  server.registerTool(
    "process",
    {
      description: "Manage persistent processes with one compact tool: start, read/wait, input, kill or list.",
      inputSchema: z.object({
        action: z.enum(["start", "read", "input", "kill", "list"]),
        sessionId: z.string().uuid().optional(),
        command: z.string().min(1).optional(),
        cwd: z.string().optional(),
        shell: z.string().optional(),
        cursor: z.number().int().min(0).optional(),
        waitMs: z.number().int().min(0).max(30000).default(0),
        input: z.string().optional(),
        newline: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args) => runTool("process", args, async () => {
      if (args.action === "list") return { sessions: processes.list() };

      if (args.action === "start") {
        if (!args.command) throw new Error("command is required for action=start");
        const session = await processes.start(args.command, args.cwd, args.shell);
        return {
          sessionId: session.id,
          pid: session.child.pid,
          command: session.command,
          cwd: session.cwd,
          workspace: session.workspace,
          queueWaitMs: session.queueWaitMs
        };
      }

      if (!args.sessionId) throw new Error(`sessionId is required for action=${args.action}`);

      if (args.action === "read") {
        return await processes.readWait(args.sessionId, args.cursor, args.waitMs);
      }
      if (args.action === "input") {
        if (args.input === undefined) throw new Error("input is required for action=input");
        await processes.input(args.sessionId, args.input, args.newline);
        return { sessionId: args.sessionId, writtenChars: args.input.length, newline: args.newline };
      }

      await processes.kill(args.sessionId);
      return { sessionId: args.sessionId, killed: true };
    })
  );
}
