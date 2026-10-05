import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FairConcurrencyPool, KeyedMutex } from "../dist/concurrency.js";
import { clearWorkspaceCache, workspaceForPath } from "../dist/workspace.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pool = new FairConcurrencyPool("test", 3, 2);
let activeGlobal = 0;
let maxGlobal = 0;
const activeByWorkspace = new Map();
const maxByWorkspace = new Map();
const startOrder = [];

async function job(workspace, id, ms = 40) {
  return await pool.run(workspace, async () => {
    startOrder.push(`${workspace}:${id}`);
    activeGlobal += 1;
    maxGlobal = Math.max(maxGlobal, activeGlobal);
    const next = (activeByWorkspace.get(workspace) ?? 0) + 1;
    activeByWorkspace.set(workspace, next);
    maxByWorkspace.set(workspace, Math.max(maxByWorkspace.get(workspace) ?? 0, next));
    await sleep(ms);
    activeGlobal -= 1;
    activeByWorkspace.set(workspace, next - 1);
    return id;
  }, 5000);
}

const jobs = [];
for (let i = 1; i <= 8; i++) jobs.push(job("project-a", i));
jobs.push(job("project-b", 1));
jobs.push(job("project-b", 2));
await Promise.all(jobs);

assert(maxGlobal <= 3, `global concurrency exceeded: ${maxGlobal}`);
assert((maxByWorkspace.get("project-a") ?? 0) <= 2);
assert((maxByWorkspace.get("project-b") ?? 0) <= 2);
assert(startOrder.slice(0, 3).some((item) => item.startsWith("project-b:")), `fairness failed: ${startOrder.join(", ")}`);

const mutex = new KeyedMutex();
let sameKeyActive = 0;
let maxSameKeyActive = 0;
let otherKeyOverlapped = false;

const sameA = mutex.withKeys(["same-file"], async () => {
  sameKeyActive += 1;
  maxSameKeyActive = Math.max(maxSameKeyActive, sameKeyActive);
  await sleep(60);
  sameKeyActive -= 1;
});
const sameB = mutex.withKeys(["same-file"], async () => {
  sameKeyActive += 1;
  maxSameKeyActive = Math.max(maxSameKeyActive, sameKeyActive);
  await sleep(20);
  sameKeyActive -= 1;
});
const other = mutex.withKeys(["other-file"], async () => {
  await sleep(10);
  if (sameKeyActive > 0) otherKeyOverlapped = true;
});

await Promise.all([sameA, sameB, other]);
assert.equal(maxSameKeyActive, 1);
assert.equal(otherKeyOverlapped, true);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rob-dc-workspace-"));
try {
  const nested = path.join(tempRoot, "packages", "app", "src");
  await fs.mkdir(path.join(tempRoot, ".git"), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(tempRoot, "packages", "app", "package.json"), "{}");
  clearWorkspaceCache();
  const detected = await workspaceForPath(nested);
  const expected = process.platform === "win32" ? tempRoot.toLowerCase() : tempRoot;
  assert.equal(detected, expected, "git root must win over nested package marker");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

const markerBase = await fs.mkdtemp(path.join(os.tmpdir(), "rob-dc-marker-"));
try {
  const markerProject = path.join(markerBase, "project");
  const markerNested = path.join(markerProject, "src", "nested");
  await fs.mkdir(markerNested, { recursive: true });
  await fs.writeFile(path.join(markerProject, "package.json"), "{}");
  clearWorkspaceCache();
  const detectedProject = await workspaceForPath(markerNested);
  const expectedProject = process.platform === "win32" ? markerProject.toLowerCase() : markerProject;
  assert.equal(detectedProject, expectedProject);

  const detectedAncestor = await workspaceForPath(markerBase);
  const expectedAncestor = process.platform === "win32" ? markerBase.toLowerCase() : markerBase;
  assert.equal(detectedAncestor, expectedAncestor, "project cache must not leak upward into ancestor directories");
} finally {
  await fs.rm(markerBase, { recursive: true, force: true });
}

const timeoutPool = new FairConcurrencyPool("timeout-test", 1, 1);
const holder = timeoutPool.run("a", async () => { await sleep(80); }, 1000);
await sleep(5);
await assert.rejects(
  timeoutPool.run("b", async () => undefined, 10),
  /Concurrency queue timeout/
);
await holder;

const boundedPool = new FairConcurrencyPool("bounded-test", 1, 1, 2, 1);
const boundedHolder = boundedPool.run("a", async () => { await sleep(80); }, 1000);
await sleep(5);
const boundedQueued = boundedPool.run("b", async () => undefined, 1000);
await sleep(5);
await assert.rejects(
  boundedPool.run("b", async () => undefined, 1000),
  /Concurrency queue full/
);
await Promise.all([boundedHolder, boundedQueued]);
assert.equal(boundedPool.snapshot().totalRejected, 1);

console.log(JSON.stringify({
  ok: true,
  maxGlobal,
  maxByWorkspace: Object.fromEntries(maxByWorkspace),
  fairnessFirstStarts: startOrder.slice(0, 5),
  sameKeySerialized: maxSameKeyActive === 1,
  differentKeysCanOverlap: otherKeyOverlapped
}, null, 2));
