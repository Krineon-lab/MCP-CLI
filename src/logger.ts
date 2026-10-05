import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(token|secret|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

function sanitize(value: unknown, depth = 0, includePayloads = config.logIncludePayloads): unknown {
  if (depth > 6) return "[MAX_DEPTH]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!includePayloads) {
      const preview = redactString(value.slice(0, 512)).slice(0, 160);
      return { type: "string", chars: value.length, preview };
    }
    const clipped = value.length > 8_000 ? value.slice(0, 8_000) + `...[+${value.length - 8_000} chars]` : value;
    return redactString(clipped);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1, includePayloads));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(child, depth + 1, includePayloads);
    }
    return out;
  }
  return String(value);
}

class DebugLogger {
  private runtimeEnabled = config.logEnabled;
  private runtimeLevel: LogLevel = config.logLevel;
  private queue: string[] = [];
  private flushTimer?: NodeJS.Timeout;
  private filePath: string | null = null;
  private currentBytes = 0;
  private part = 0;
  private flushing: Promise<void> | null = null;
  private initialized = false;
  private droppedEvents = 0;
  private readonly startedStamp = new Date().toISOString().replace(/[:.]/g, "-");

  enabled(): boolean {
    return this.runtimeEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.runtimeEnabled = enabled;
    if (enabled) this.scheduleFlush();
  }

  setLevel(level: LogLevel): void {
    this.runtimeLevel = level;
  }

  private levelEnabled(level: LogLevel): boolean {
    return this.runtimeEnabled && RANK[level] >= RANK[this.runtimeLevel];
  }

  private async initialize(): Promise<void> {
    if (this.initialized || !this.runtimeEnabled) return;
    await fs.mkdir(config.logDir, { recursive: true });
    this.filePath = this.nextFilePath();
    try {
      this.currentBytes = (await fs.stat(this.filePath)).size;
    } catch {
      this.currentBytes = 0;
    }
    this.initialized = true;
    await this.cleanupOldFiles();
  }

  private nextFilePath(): string {
    const suffix = this.part === 0 ? "" : `-part${this.part}`;
    return path.join(config.logDir, `rob-dc-${this.startedStamp}-pid${process.pid}${suffix}.jsonl`);
  }

  private async cleanupOldFiles(): Promise<void> {
    try {
      const entries = (await fs.readdir(config.logDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith("rob-dc-") && entry.name.endsWith(".jsonl"));
      const stats = await Promise.all(entries.map(async (entry) => ({
        path: path.join(config.logDir, entry.name),
        mtime: (await fs.stat(path.join(config.logDir, entry.name))).mtimeMs
      })));
      stats.sort((a, b) => b.mtime - a.mtime);
      const keepExisting = Math.max(0, config.logMaxFiles - 1);
      await Promise.all(stats.slice(keepExisting).map((entry) => fs.rm(entry.path, { force: true })));
    } catch {
      // Logging must never break the MCP server.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.runtimeEnabled) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, config.logFlushMs);
    this.flushTimer.unref();
  }

  log(level: LogLevel, event: string, data?: unknown): void {
    if (!this.levelEnabled(level)) return;
    if (this.queue.length >= config.logBufferMaxEvents) {
      const dropCount = Math.max(1, Math.floor(config.logBufferMaxEvents * 0.1));
      this.queue.splice(0, dropCount);
      this.droppedEvents += dropCount;
    }
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      data: data === undefined ? undefined : sanitize(data)
    };
    this.queue.push(JSON.stringify(record) + "\n");
    if (this.queue.length >= 100) void this.flush();
    else this.scheduleFlush();
  }

  debug(event: string, data?: unknown): void { this.log("debug", event, data); }
  info(event: string, data?: unknown): void { this.log("info", event, data); }
  warn(event: string, data?: unknown): void { this.log("warn", event, data); }
  error(event: string, data?: unknown): void { this.log("error", event, data); }

  async flush(): Promise<void> {
    if (!this.runtimeEnabled || this.queue.length === 0) return;
    if (this.flushing) {
      await this.flushing;
      if (this.queue.length === 0) return;
    }

    this.flushing = (async () => {
      try {
        await this.initialize();
        if (!this.filePath) return;
        const batch = this.queue.splice(0, this.queue.length);
        const text = batch.join("");
        const bytes = Buffer.byteLength(text);

        if (this.currentBytes > 0 && this.currentBytes + bytes > config.logMaxBytes) {
          this.part += 1;
          this.filePath = this.nextFilePath();
          this.currentBytes = 0;
          await this.cleanupOldFiles();
        }

        await fs.appendFile(this.filePath, text, "utf8");
        this.currentBytes += bytes;
      } catch {
        // Never fail the caller because debug logging failed.
      } finally {
        this.flushing = null;
      }
    })();

    await this.flushing;
  }

  status() {
    return {
      enabled: this.runtimeEnabled,
      configuredEnabled: config.logEnabled,
      level: this.runtimeLevel,
      configuredLevel: config.logLevel,
      directory: config.logDir,
      currentFile: this.filePath,
      includePayloads: config.logIncludePayloads,
      queuedEvents: this.queue.length,
      droppedEvents: this.droppedEvents,
      maxBytesPerFile: config.logMaxBytes,
      maxFiles: config.logMaxFiles,
      flushMs: config.logFlushMs
    };
  }
}

export const logger = new DebugLogger();
