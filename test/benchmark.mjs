import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { FairConcurrencyPool } from "../dist/concurrency.js";
import { readTailLines, readTextRange } from "../dist/fs-ops.js";
import { workspaceForPath, clearWorkspaceCache } from "../dist/workspace.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rob-dc-bench-"));
const file = path.join(dir, "bench.log");
await fs.mkdir(path.join(dir, ".git"));
await fs.writeFile(file, Array.from({ length: 50_000 }, (_, i) => `row-${i}`).join("\n") + "\n");

async function measure(name, fn) {
  const start = performance.now();
  await fn();
  return { name, ms: Math.round((performance.now() - start) * 100) / 100 };
}

try {
  clearWorkspaceCache();
  const results = [];
  results.push(await measure("workspace cold+999 warm", async () => {
    for (let i = 0; i < 1000; i++) await workspaceForPath(file);
  }));
  results.push(await measure("tail x100", async () => {
    for (let i = 0; i < 100; i++) await readTailLines(file, 20, 64 * 1024);
  }));
  results.push(await measure("range line 40000 x20", async () => {
    for (let i = 0; i < 20; i++) await readTextRange(file, 40_000, 20);
  }));
  results.push(await measure("scheduler 2000 jobs", async () => {
    const pool = new FairConcurrencyPool("bench", 16, 4, 5000, 500);
    await Promise.all(Array.from({ length: 2000 }, (_, i) =>
      pool.run(`p-${i % 20}`, async () => undefined, 5000)
    ));
  }));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
