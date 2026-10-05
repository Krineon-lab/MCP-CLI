import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";

export function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function hashFile(file: string): Promise<string | null> {
  return await new Promise<string | null>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    let settled = false;

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") resolve(null);
      else reject(error);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(hash.digest("hex"));
    });
  });
}

export async function readBinaryPrefix(file: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean; size: number }> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  const length = Math.min(stat.size, maxBytes);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { buffer: buffer.subarray(0, bytesRead), truncated: stat.size > bytesRead, size: stat.size };
  } finally {
    await handle.close();
  }
}

export async function readTextRange(file: string, offsetLine: number, maxLines: number): Promise<{
  content: string;
  returnedLines: number;
  hasMoreLines: boolean;
  scannedLines: number;
  size: number;
}> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);

  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let lineNo = 0;
  let hasMoreLines = false;

  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < offsetLine) continue;
      if (selected.length < maxLines) {
        selected.push(line);
        continue;
      }
      hasMoreLines = true;
      break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    content: selected.join("\n"),
    returnedLines: selected.length,
    hasMoreLines,
    scannedLines: lineNo,
    size: stat.size
  };
}

export async function readTailLines(file: string, tailLines: number, maxBytes: number): Promise<{
  content: string;
  returnedLines: number;
  truncatedByBytes: boolean;
  size: number;
}> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  if (stat.size === 0) return { content: "", returnedLines: 0, truncatedByBytes: false, size: 0 };

  const bytesToRead = Math.min(stat.size, maxBytes);
  const start = stat.size - bytesToRead;
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    let lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
    const selected = lines.slice(-tailLines);
    return {
      content: selected.join("\n"),
      returnedLines: selected.length,
      truncatedByBytes: start > 0,
      size: stat.size
    };
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.rob-dc-${process.pid}-${crypto.randomUUID()}.tmp`);
  let existingMode: number | undefined;
  if (process.platform !== "win32") {
    try {
      existingMode = (await fs.stat(file)).mode;
    } catch {
      existingMode = undefined;
    }
  }

  await fs.writeFile(temp, content, "utf8");
  if (existingMode !== undefined) {
    await fs.chmod(temp, existingMode);
  }

  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

export async function listTree(
  root: string,
  depth: number,
  maxEntries: number,
  excludedNames: Set<string>
): Promise<{ items: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }>; truncated: boolean }> {
  const items: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }> = [];
  const stack: Array<{ dir: string; level: number }> = [{ dir: root, level: 1 }];
  const normalizeName = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
  const excluded = new Set([...excludedNames].map(normalizeName));

  while (stack.length > 0 && items.length < maxEntries) {
    const current = stack.pop()!;
    if (current.level > depth) continue;

    const entries = await fs.readdir(current.dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const childDirs: string[] = [];

    for (const entry of entries) {
      if (excluded.has(normalizeName(entry.name))) continue;
      if (items.length >= maxEntries) break;
      const absolute = path.join(current.dir, entry.name);
      const relative = path.relative(root, absolute) || ".";
      const type = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other";
      items.push({ path: relative, type });
      if (entry.isDirectory() && current.level < depth) childDirs.push(absolute);
    }

    for (let i = childDirs.length - 1; i >= 0; i--) {
      stack.push({ dir: childDirs[i], level: current.level + 1 });
    }
  }

  return { items, truncated: items.length >= maxEntries };
}
