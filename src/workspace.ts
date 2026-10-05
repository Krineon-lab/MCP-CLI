import fs from "node:fs/promises";
import path from "node:path";

const cache = new Map<string, string>();
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"];

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cacheWorkspace(visited: string[], workspace: string): void {
  for (const item of visited) {
    if (isInside(workspace, item)) cache.set(item, workspace);
  }
}

export async function workspaceForPath(input: string): Promise<string> {
  const resolved = path.resolve(input);
  let start = resolved;

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) start = path.dirname(resolved);
  } catch {
    start = path.dirname(resolved);
  }

  const normalizedStart = normalize(start);
  const cached = cache.get(normalizedStart);
  if (cached) return cached;

  const visited: string[] = [];
  let current = start;
  let fallback: string | null = null;

  while (true) {
    const normalizedCurrent = normalize(current);
    visited.push(normalizedCurrent);

    if (await exists(path.join(current, ".git"))) {
      const workspace = normalizedCurrent;
      cacheWorkspace(visited, workspace);
      return workspace;
    }

    if (!fallback) {
      const checks = await Promise.all(PROJECT_MARKERS.map((marker) => exists(path.join(current, marker))));
      if (checks.some(Boolean)) fallback = normalizedCurrent;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const workspace = fallback ?? normalizedStart;
  cacheWorkspace(visited, workspace);
  return workspace;
}

export function workspaceLabel(workspace: string): string {
  return path.basename(workspace) || workspace;
}

export function clearWorkspaceCache(): void {
  cache.clear();
}
