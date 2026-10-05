import os from "node:os";
import path from "node:path";

export const VERSION = "0.2.0";
export const SERVER_NAME = "Rob Desktop Commander";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function allowedDirectories(): string[] {
  const raw = process.env.ROB_DC_ALLOWED_DIRS?.trim();
  if (raw === "*") return [];
  if (!raw) return [os.homedir()];
  return raw.split(path.delimiter).map((p) => path.resolve(p.trim())).filter(Boolean);
}

export const config = {
  defaultShell: process.env.ROB_DC_SHELL || (process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash"),
  allowedDirectories: allowedDirectories(),
  allowDangerousCommands: process.env.ROB_DC_ALLOW_DANGEROUS === "1",
  defaultTimeoutMs: intEnv("ROB_DC_TIMEOUT_MS", 30_000, 100, 600_000),
  detachAfterMs: intEnv("ROB_DC_DETACH_AFTER_MS", 2_500, 0, 30_000),
  queueTimeoutMs: intEnv("ROB_DC_QUEUE_TIMEOUT_MS", 15_000, 100, 120_000),
  maxOutputChars: intEnv("ROB_DC_MAX_OUTPUT_CHARS", 1_000_000, 10_000, 10_000_000),
  maxReadBytes: intEnv("ROB_DC_MAX_READ_BYTES", 2_000_000, 4_096, 20_000_000),
  maxSearchResults: intEnv("ROB_DC_MAX_SEARCH_RESULTS", 500, 1, 10_000),
  maxConcurrentProcesses: intEnv("ROB_DC_MAX_PROCESSES", 8, 1, 64),
  maxConcurrentProcessesPerWorkspace: intEnv("ROB_DC_MAX_PROCESSES_PER_WORKSPACE", 3, 1, 32),
  maxConcurrentSearches: intEnv("ROB_DC_MAX_SEARCHES", 4, 1, 32),
  maxConcurrentSearchesPerWorkspace: intEnv("ROB_DC_MAX_SEARCHES_PER_WORKSPACE", 2, 1, 16),
  maxConcurrentIo: intEnv("ROB_DC_MAX_IO", 24, 1, 128),
  maxConcurrentIoPerWorkspace: intEnv("ROB_DC_MAX_IO_PER_WORKSPACE", 8, 1, 64)
} as const;
