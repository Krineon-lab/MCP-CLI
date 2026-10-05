import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

interface CacheEntry {
  workspace: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const PROJECT_MARKERS = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
  "Gemfile", "mix.exs", "deno.json", "deno.jsonc"
]);

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getCached(key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.workspace;
}

function setCached(key: string, workspace: string): void {
  cache.delete(key);
  cache.set(key, {
    workspace,
    expiresAt: Date.now() + config.workspaceCacheTtlMs
  });
  while (cache.size > config.workspaceCacheMaxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function cacheWorkspace(visited: string[], workspace: string, requestedPath?: string): void {
  for (const item of visited) {
    if (isInside(workspace, item)) setCached(item, workspace);
  }
  if (requestedPath) setCached(requestedPath, workspace);
}

async function directoryNames(dir: string): Promise<Set<string>> {
  try {
    const names = await fs.readdir(dir);
    return new Set(names.map((name) => process.platform === "win32" ? name.toLowerCase() : name));
  } catch {
    return new Set();
  }
}

export async function workspaceForPath(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const normalizedRequested = normalize(resolved);
  const directCached = getCached(normalizedRequested);
  if (directCached) return directCached;

  let start = resolved;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) start = path.dirname(resolved);
  } catch {
    start = path.dirname(resolved);
  }

  const normalizedStart = normalize(start);
  const cached = getCached(normalizedStart);
  if (cached) {
    setCached(normalizedRequested, cached);
    return cached;
  }

  const visited: string[] = [];
  let current = start;
  let fallback: string | null = null;

  while (true) {
    const normalizedCurrent = normalize(current);
    visited.push(normalizedCurrent);
    const names = await directoryNames(current);

    if (names.has(".git")) {
      cacheWorkspace(visited, normalizedCurrent, normalizedRequested);
      return normalizedCurrent;
    }

    if (!fallback) {
      for (const marker of PROJECT_MARKERS) {
        const key = process.platform === "win32" ? marker.toLowerCase() : marker;
        if (names.has(key)) {
          fallback = normalizedCurrent;
          break;
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const workspace = fallback ?? normalizedStart;
  cacheWorkspace(visited, workspace, normalizedRequested);
  return workspace;
}

export function clearWorkspaceCache(): void {
  cache.clear();
}

export function workspaceCacheSize(): number {
  return cache.size;
}
