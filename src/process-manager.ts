import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { config } from "./config.js";
import { processPool } from "./resource-manager.js";
import { assertAllowed, assertCommandAllowed, truncate } from "./security.js";
import { workspaceForPath } from "./workspace.js";
import type { Lease } from "./concurrency.js";

export type StreamName = "stdout" | "stderr";

export interface OutputEvent {
  seq: number;
  stream: StreamName;
  text: string;
  at: string;
}

interface Session {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  workspace: string;
  queueWaitMs: number;
  capacityLease: Lease;
  startedAt: number;
  events: OutputEvent[];
  nextSeq: number;
  readCursor: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finishedAt: number | null;
  done: Promise<void>;
}

export interface ExecResult {
  detached: boolean;
  sessionId?: string;
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  workspace: string;
  queueWaitMs: number;
}

export class ProcessManager {
  private sessions = new Map<string, Session>();

  private append(session: Session, stream: StreamName, chunk: Buffer | string): void {
    const text = chunk.toString();
    session.events.push({
      seq: session.nextSeq++,
      stream,
      text,
      at: new Date().toISOString()
    });

    let chars = 0;
    for (let i = session.events.length - 1; i >= 0; i--) {
      chars += session.events[i].text.length;
      if (chars > config.maxOutputChars * 2) {
        session.events.splice(0, i + 1);
        break;
      }
    }
  }

  async start(command: string, cwd?: string, shell?: string): Promise<Session> {
    assertCommandAllowed(command);
    const actualCwd = await assertAllowed(cwd || os.homedir());
    const actualShell = shell || config.defaultShell;
    const workspace = await workspaceForPath(actualCwd);
    const capacityLease = await processPool.acquire(workspace, config.queueTimeoutMs);
    const id = randomUUID();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [], {
        cwd: actualCwd,
        shell: actualShell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
    } catch (error) {
      capacityLease.release();
      throw error;
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const session: Session = {
      id,
      child,
      command,
      cwd: actualCwd,
      workspace,
      queueWaitMs: capacityLease.waitedMs,
      capacityLease,
      startedAt: Date.now(),
      events: [],
      nextSeq: 0,
      readCursor: 0,
      exitCode: null,
      signal: null,
      finishedAt: null,
      done
    };
    this.sessions.set(id, session);

    child.stdout.on("data", (chunk) => this.append(session, "stdout", chunk));
    child.stderr.on("data", (chunk) => this.append(session, "stderr", chunk));
    child.on("error", (error) => this.append(session, "stderr", `[spawn error] ${error.message}\n`));
    child.on("close", (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      session.finishedAt = Date.now();
      session.capacityLease.release();
      resolveDone();
      const cleanup = setTimeout(() => this.sessions.delete(id), 10 * 60_000);
      cleanup.unref();
    });

    return session;
  }

  private combined(session: Session): { stdout: string; stderr: string; truncated: boolean } {
    const stdout = session.events.filter((e) => e.stream === "stdout").map((e) => e.text).join("");
    const stderr = session.events.filter((e) => e.stream === "stderr").map((e) => e.text).join("");
    const out = truncate(stdout);
    const err = truncate(stderr);
    return { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  }

  async exec(command: string, options: { cwd?: string; shell?: string; detachAfterMs?: number; timeoutMs?: number } = {}): Promise<ExecResult> {
    const session = await this.start(command, options.cwd, options.shell);
    const detachAfterMs = options.detachAfterMs ?? config.detachAfterMs;
    const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;

    let timeoutHit = false;
    const timeout = setTimeout(() => {
      timeoutHit = true;
      void this.kill(session.id);
    }, timeoutMs);
    timeout.unref();
    void session.done.then(() => clearTimeout(timeout));

    const detached = await Promise.race([
      session.done.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), detachAfterMs))
    ]);

    if (detached && session.finishedAt === null) {
      const output = this.combined(session);
      return {
        detached: true,
        sessionId: session.id,
        pid: session.child.pid,
        exitCode: null,
        signal: null,
        ...output,
        durationMs: Date.now() - session.startedAt,
        workspace: session.workspace,
        queueWaitMs: session.queueWaitMs
      };
    }

    clearTimeout(timeout);
    await session.done;
    const output = this.combined(session);
    this.sessions.delete(session.id);
    if (timeoutHit) {
      output.stderr += output.stderr ? "\n[timeout reached]" : "[timeout reached]";
    }
    return {
      detached: false,
      pid: session.child.pid,
      exitCode: session.exitCode,
      signal: session.signal,
      ...output,
      durationMs: (session.finishedAt ?? Date.now()) - session.startedAt,
      workspace: session.workspace,
      queueWaitMs: session.queueWaitMs
    };
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown or expired session: ${id}`);
    return session;
  }

  read(id: string, cursor?: number): {
    sessionId: string;
    pid?: number;
    running: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    workspace: string;
    queueWaitMs: number;
    cursor: number;
    events: OutputEvent[];
  } {
    const session = this.get(id);
    const start = cursor ?? session.readCursor;
    const events = session.events.filter((event) => event.seq >= start);
    const nextCursor = events.length ? events[events.length - 1].seq + 1 : Math.max(start, session.nextSeq);
    if (cursor === undefined) session.readCursor = nextCursor;
    return {
      sessionId: id,
      pid: session.child.pid,
      running: session.finishedAt === null,
      exitCode: session.exitCode,
      signal: session.signal,
      workspace: session.workspace,
      queueWaitMs: session.queueWaitMs,
      cursor: nextCursor,
      events
    };
  }

  input(id: string, input: string, newline = true): void {
    const session = this.get(id);
    if (session.finishedAt !== null) throw new Error("Process has already exited");
    session.child.stdin.write(input + (newline ? "\n" : ""));
  }

  async kill(id: string): Promise<void> {
    const session = this.get(id);
    if (session.finishedAt !== null) return;
    const pid = session.child.pid;
    if (process.platform === "win32" && pid) {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolve) => killer.once("close", () => resolve()));
    } else {
      session.child.kill("SIGTERM");
    }
  }

  list(): Array<{ sessionId: string; pid?: number; command: string; cwd: string; workspace: string; queueWaitMs: number; running: boolean; startedAt: string; exitCode: number | null }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      pid: s.child.pid,
      command: s.command,
      cwd: s.cwd,
      workspace: s.workspace,
      queueWaitMs: s.queueWaitMs,
      running: s.finishedAt === null,
      startedAt: new Date(s.startedAt).toISOString(),
      exitCode: s.exitCode
    }));
  }
}

export const processes = new ProcessManager();
