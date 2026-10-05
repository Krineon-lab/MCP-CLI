import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";
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
  maxOutputChars: intEnv("ROB_DC_MAX_OUTPUT_CHARS", 1_000_000, 10_000, 10_000_000),
  maxReadBytes: intEnv("ROB_DC_MAX_READ_BYTES", 2_000_000, 4_096, 20_000_000),
  maxSearchResults: intEnv("ROB_DC_MAX_SEARCH_RESULTS", 500, 1, 10_000)
} as const;
