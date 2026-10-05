import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { config } from "./config.js";
import { processPool } from "./resource-manager.js";
import { assertAllowed, assertCommandAllowed, truncate } from "./security.js";
import { workspaceForPath } from "./workspace.js";
import { logger } from "./logger.js";
import type { Lease } from "./concurrency.js";

export type StreamName = "stdout" | "stderr";

export interface OutputEvent {
  seq: number;
  stream: StreamName;
  text: string;
  at: string;
}

export interface Session {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  workspace: string;
  queueWaitMs: number;
  capacityLease: Lease;
  startedAt: number;
  events: OutputEvent[];
  eventChars: number;
  droppedBeforeSeq: number;
  nextSeq: number;
  readCursor: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  finishedAt: number | null;
  done: Promise<void>;
  waiters: Set<() => void>;
}

export interface ExecResult {
  detached: boolean;
  sessionId?: string;
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  droppedBeforeSeq: number;
  durationMs: number;
  workspace: string;
  queueWaitMs: number;
}

export interface SessionReadResult {
  sessionId: string;
  pid?: number;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  workspace: string;
  queueWaitMs: number;
  cursor: number;
  droppedBeforeSeq: number;
  events: OutputEvent[];
}

export class ProcessManager {
  private sessions = new Map<string, Session>();

  private notify(session: Session): void {
    if (session.waiters.size === 0) return;
    const waiters = [...session.waiters];
    session.waiters.clear();
    for (const wake of waiters) wake();
  }

  private append(session: Session, stream: StreamName, chunk: Buffer | string): void {
    const text = chunk.toString();
    const event: OutputEvent = {
      seq: session.nextSeq++,
      stream,
      text,
      at: new Date().toISOString()
    };
    session.events.push(event);
    session.eventChars += text.length;

    const hardLimit = config.maxOutputChars * 2;
    if (session.eventChars > hardLimit) {
      const target = Math.floor(config.maxOutputChars * 1.5);
      let removeChars = 0;
      let removeCount = 0;
      while (removeCount < session.events.length && session.eventChars - removeChars > target) {
        removeChars += session.events[removeCount].text.length;
        removeCount += 1;
      }
      if (removeCount > 0) {
        const removed = session.events.splice(0, removeCount);
        session.eventChars -= removeChars;
        session.droppedBeforeSeq = removed[removed.length - 1].seq + 1;
        if (session.readCursor < session.droppedBeforeSeq) session.readCursor = session.droppedBeforeSeq;
      }
    }

    this.notify(session);
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
      eventChars: 0,
      droppedBeforeSeq: 0,
      nextSeq: 0,
      readCursor: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      finishedAt: null,
      done,
      waiters: new Set()
    };
    this.sessions.set(id, session);

    logger.debug("process.started", {
      sessionId: id,
      pid: child.pid,
      command,
      cwd: actualCwd,
      workspace,
      queueWaitMs: session.queueWaitMs
    });

    child.stdout.on("data", (chunk) => this.append(session, "stdout", chunk));
    child.stderr.on("data", (chunk) => this.append(session, "stderr", chunk));
    child.on("error", (error) => {
      this.append(session, "stderr", `[spawn error] ${error.message}\n`);
      logger.error("process.error", { sessionId: id, pid: child.pid, message: error.message });
    });
    child.on("close", (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      session.finishedAt = Date.now();
      session.capacityLease.release();
      resolveDone();
      this.notify(session);

      logger.debug("process.closed", {
        sessionId: id,
        pid: child.pid,
        exitCode: code,
        signal,
        timedOut: session.timedOut,
        durationMs: session.finishedAt - session.startedAt,
        outputChars: session.eventChars,
        droppedBeforeSeq: session.droppedBeforeSeq
      });

      const cleanup = setTimeout(() => this.sessions.delete(id), config.sessionRetentionMs);
      cleanup.unref();
    });

    return session;
  }

  private combined(session: Session): { stdout: string; stderr: string; truncated: boolean } {
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    for (const event of session.events) {
      (event.stream === "stdout" ? stdoutParts : stderrParts).push(event.text);
    }
    const out = truncate(stdoutParts.join(""));
    const err = truncate(stderrParts.join(""));
    return {
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated || session.droppedBeforeSeq > 0
    };
  }

  async exec(command: string, options: { cwd?: string; shell?: string; detachAfterMs?: number; timeoutMs?: number } = {}): Promise<ExecResult> {
    const session = await this.start(command, options.cwd, options.shell);
    const detachAfterMs = options.detachAfterMs ?? config.detachAfterMs;
    const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;

    const timeout = setTimeout(() => {
      session.timedOut = true;
      logger.warn("process.timeout", { sessionId: session.id, pid: session.child.pid, timeoutMs });
      void this.kill(session.id);
    }, timeoutMs);
    timeout.unref();
    void session.done.then(() => clearTimeout(timeout));

    let detachTimer: NodeJS.Timeout | undefined;
    const detachPromise = new Promise<boolean>((resolve) => {
      if (detachAfterMs === 0) {
        resolve(true);
        return;
      }
      detachTimer = setTimeout(() => resolve(true), detachAfterMs);
      detachTimer.unref();
    });

    const detached = await Promise.race([
      session.done.then(() => false),
      detachPromise
    ]);
    if (detachTimer) clearTimeout(detachTimer);

    if (detached && session.finishedAt === null) {
      const output = this.combined(session);
      return {
        detached: true,
        sessionId: session.id,
        pid: session.child.pid,
        exitCode: null,
        signal: null,
        timedOut: false,
        ...output,
        droppedBeforeSeq: session.droppedBeforeSeq,
        durationMs: Date.now() - session.startedAt,
        workspace: session.workspace,
        queueWaitMs: session.queueWaitMs
      };
    }

    clearTimeout(timeout);
    await session.done;
    const output = this.combined(session);
    this.sessions.delete(session.id);

    return {
      detached: false,
      pid: session.child.pid,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut,
      ...output,
      droppedBeforeSeq: session.droppedBeforeSeq,
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

  read(id: string, cursor?: number): SessionReadResult {
    const session = this.get(id);
    const requested = cursor ?? session.readCursor;
    const start = Math.max(requested, session.droppedBeforeSeq);
    const firstSeq = session.events[0]?.seq ?? session.nextSeq;
    const index = Math.max(0, start - firstSeq);
    const events = session.events.slice(index);
    const nextCursor = events.length ? events[events.length - 1].seq + 1 : Math.max(start, session.nextSeq);
    if (cursor === undefined) session.readCursor = nextCursor;

    return {
      sessionId: id,
      pid: session.child.pid,
      running: session.finishedAt === null,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut,
      workspace: session.workspace,
      queueWaitMs: session.queueWaitMs,
      cursor: nextCursor,
      droppedBeforeSeq: session.droppedBeforeSeq,
      events
    };
  }

  async readWait(id: string, cursor?: number, waitMs = 0): Promise<SessionReadResult> {
    const initial = this.read(id, cursor);
    if (waitMs <= 0 || !initial.running || initial.events.length > 0) return initial;

    const session = this.get(id);
    const checkCursor = cursor ?? initial.cursor;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        session.waiters.delete(finish);
        if (timer) clearTimeout(timer);
        resolve();
      };

      session.waiters.add(finish);

      // Close the race where output arrives after the initial read but before
      // the waiter is registered.
      const afterSubscribe = this.read(id, checkCursor);
      if (!afterSubscribe.running || afterSubscribe.events.length > 0) {
        finish();
        return;
      }

      timer = setTimeout(finish, waitMs);
      timer.unref();
    });

    return this.read(id, cursor);
  }

  async input(id: string, input: string, newline = true): Promise<void> {
    const session = this.get(id);
    if (session.finishedAt !== null) throw new Error("Process has already exited");
    const accepted = session.child.stdin.write(input + (newline ? "\n" : ""));
    if (!accepted) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => {
          session.child.stdin.off("drain", onDrain);
          session.child.stdin.off("error", onError);
        };
        session.child.stdin.once("drain", onDrain);
        session.child.stdin.once("error", onError);
      });
    }
  }

  async kill(id: string): Promise<void> {
    const session = this.get(id);
    if (session.finishedAt !== null) return;
    const pid = session.child.pid;
    logger.debug("process.kill", { sessionId: id, pid });

    if (process.platform === "win32" && pid) {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolve) => killer.once("close", () => resolve()));
    } else {
      session.child.kill("SIGTERM");
    }
  }

  list(): Array<{
    sessionId: string;
    pid?: number;
    command: string;
    cwd: string;
    workspace: string;
    queueWaitMs: number;
    running: boolean;
    startedAt: string;
    finishedAt: string | null;
    exitCode: number | null;
    timedOut: boolean;
    bufferedEvents: number;
    bufferedChars: number;
    droppedBeforeSeq: number;
  }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      pid: s.child.pid,
      command: s.command,
      cwd: s.cwd,
      workspace: s.workspace,
      queueWaitMs: s.queueWaitMs,
      running: s.finishedAt === null,
      startedAt: new Date(s.startedAt).toISOString(),
      finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
      exitCode: s.exitCode,
      timedOut: s.timedOut,
      bufferedEvents: s.events.length,
      bufferedChars: s.eventChars,
      droppedBeforeSeq: s.droppedBeforeSeq
    }));
  }
}

export const processes = new ProcessManager();
