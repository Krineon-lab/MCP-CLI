import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export function expandPath(input: string): string {
  if (!input) throw new Error("Path is required");
  if (input === "~") return process.env.USERPROFILE || process.env.HOME || input;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) return path.join(home, input.slice(2));
  }
  return path.resolve(input);
}

function inside(root: string, target: string): boolean {
  const a = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  const b = process.platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target);
  const rel = path.relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function assertAllowed(input: string, forWrite = false): Promise<string> {
  const resolved = expandPath(input);
  if (config.allowedDirectories.length === 0) return resolved;

  let canonical = resolved;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    if (!forWrite) throw new Error(`Path does not exist: ${resolved}`);
    let probe = path.dirname(resolved);
    while (probe !== path.dirname(probe)) {
      try {
        const parentReal = await fs.realpath(probe);
        canonical = path.join(parentReal, path.relative(probe, resolved));
        break;
      } catch {
        probe = path.dirname(probe);
      }
    }
  }

  for (const root of config.allowedDirectories) {
    let canonicalRoot = path.resolve(root);
    try { canonicalRoot = await fs.realpath(root); } catch { }
    if (inside(canonicalRoot, canonical)) return resolved;
  }
  throw new Error(`Access denied outside ROB_DC_ALLOWED_DIRS: ${resolved}`);
}

const BLOCKED = [
  /^\s*(?:sudo\s+)?(?:mkfs(?:\.\w+)?|fdisk|parted|diskpart|format)(?:\s|$)/i,
  /^\s*(?:shutdown|reboot|halt|poweroff)(?:\s|$)/i,
  /^\s*(?:bcdedit|cipher\s+\/w)(?:\s|$)/i,
  /^\s*(?:Stop-Computer|Restart-Computer)(?:\s|$)/i
];

export function assertCommandAllowed(command: string): void {
  if (!command.trim()) throw new Error("Command is empty");
  if (config.allowDangerousCommands) return;
  if (BLOCKED.some((rule) => rule.test(command))) {
    throw new Error("Command blocked by Rob Desktop Commander safety policy. Set ROB_DC_ALLOW_DANGEROUS=1 only if you intentionally want to disable this guard.");
  }
}

export function truncate(text: string, maxChars = config.maxOutputChars): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head;
  return {
    text: text.slice(0, head) + `\n\n...[truncated ${text.length - maxChars} chars]...\n\n` + text.slice(-tail),
    truncated: true
  };
}
