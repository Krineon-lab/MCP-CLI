import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };

export const VERSION = packageJson.version;
export const SERVER_NAME = "Rob Desktop Commander";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function enumEnv<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim().toLowerCase() as T | undefined;
  return raw && values.includes(raw) ? raw : fallback;
}

function allowedDirectories(): string[] {
  const raw = process.env.ROB_DC_ALLOWED_DIRS?.trim();
  if (raw === "*") return [];
  if (!raw) return [os.homedir()];
  return raw.split(path.delimiter).map((p) => path.resolve(p.trim())).filter(Boolean);
}

const defaultLogDir = path.join(packageRoot, ".rob-dc", "logs");

export const config = {
  defaultShell: process.env.ROB_DC_SHELL || (process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash"),
  allowedDirectories: allowedDirectories(),
  allowDangerousCommands: boolEnv("ROB_DC_ALLOW_DANGEROUS"),
  defaultTimeoutMs: intEnv("ROB_DC_TIMEOUT_MS", 30_000, 100, 600_000),
  detachAfterMs: intEnv("ROB_DC_DETACH_AFTER_MS", 2_500, 0, 30_000),
  queueTimeoutMs: intEnv("ROB_DC_QUEUE_TIMEOUT_MS", 15_000, 100, 120_000),
  maxQueueGlobal: intEnv("ROB_DC_MAX_QUEUE_GLOBAL", 1_000, 10, 100_000),
  maxQueuePerWorkspace: intEnv("ROB_DC_MAX_QUEUE_PER_WORKSPACE", 100, 1, 10_000),
  sessionRetentionMs: intEnv("ROB_DC_SESSION_RETENTION_MS", 10 * 60_000, 1_000, 24 * 60 * 60_000),
  maxOutputChars: intEnv("ROB_DC_MAX_OUTPUT_CHARS", 1_000_000, 10_000, 10_000_000),
  maxReadBytes: intEnv("ROB_DC_MAX_READ_BYTES", 2_000_000, 4_096, 20_000_000),
  maxSearchResults: intEnv("ROB_DC_MAX_SEARCH_RESULTS", 500, 1, 10_000),
  workspaceCacheTtlMs: intEnv("ROB_DC_WORKSPACE_CACHE_TTL_MS", 5 * 60_000, 1_000, 24 * 60 * 60_000),
  workspaceCacheMaxEntries: intEnv("ROB_DC_WORKSPACE_CACHE_MAX", 10_000, 100, 1_000_000),
  maxConcurrentProcesses: intEnv("ROB_DC_MAX_PROCESSES", 8, 1, 64),
  maxConcurrentProcessesPerWorkspace: intEnv("ROB_DC_MAX_PROCESSES_PER_WORKSPACE", 3, 1, 32),
  maxConcurrentSearches: intEnv("ROB_DC_MAX_SEARCHES", 4, 1, 32),
  maxConcurrentSearchesPerWorkspace: intEnv("ROB_DC_MAX_SEARCHES_PER_WORKSPACE", 2, 1, 16),
  maxConcurrentIo: intEnv("ROB_DC_MAX_IO", 24, 1, 128),
  maxConcurrentIoPerWorkspace: intEnv("ROB_DC_MAX_IO_PER_WORKSPACE", 8, 1, 64),
  logEnabled: boolEnv("ROB_DC_LOG_ENABLED"),
  logLevel: enumEnv("ROB_DC_LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "debug"),
  logDir: path.resolve(process.env.ROB_DC_LOG_DIR || defaultLogDir),
  logIncludePayloads: boolEnv("ROB_DC_LOG_INCLUDE_PAYLOADS"),
  logMaxBytes: intEnv("ROB_DC_LOG_MAX_MB", 25, 1, 1024) * 1024 * 1024,
  logMaxFiles: intEnv("ROB_DC_LOG_MAX_FILES", 7, 1, 100),
  logFlushMs: intEnv("ROB_DC_LOG_FLUSH_MS", 250, 25, 10_000),
  logBufferMaxEvents: intEnv("ROB_DC_LOG_BUFFER_EVENTS", 5_000, 100, 100_000)
} as const;
