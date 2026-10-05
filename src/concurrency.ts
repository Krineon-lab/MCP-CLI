export interface PoolSnapshot {
  name: string;
  maxGlobal: number;
  maxPerWorkspace: number;
  activeGlobal: number;
  queuedGlobal: number;
  activeByWorkspace: Record<string, number>;
  queuedByWorkspace: Record<string, number>;
  totalStarted: number;
  totalCompleted: number;
  totalTimedOut: number;
}

export interface Lease {
  workspace: string;
  waitedMs: number;
  release(): void;
}

interface Waiter {
  workspace: string;
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class FairConcurrencyPool {
  private activeGlobal = 0;
  private activeByWorkspace = new Map<string, number>();
  private queues = new Map<string, Waiter[]>();
  private rotation: string[] = [];
  private totalStarted = 0;
  private totalCompleted = 0;
  private totalTimedOut = 0;

  constructor(
    readonly name: string,
    readonly maxGlobal: number,
    readonly maxPerWorkspace: number
  ) {
    if (maxGlobal < 1 || maxPerWorkspace < 1) throw new Error("Concurrency limits must be >= 1");
  }

  private canStart(workspace: string): boolean {
    return this.activeGlobal < this.maxGlobal &&
      (this.activeByWorkspace.get(workspace) ?? 0) < this.maxPerWorkspace;
  }

  private grant(waiter: Waiter): void {
    this.activeGlobal += 1;
    this.activeByWorkspace.set(waiter.workspace, (this.activeByWorkspace.get(waiter.workspace) ?? 0) + 1);
    this.totalStarted += 1;
    if (waiter.timer) clearTimeout(waiter.timer);

    let released = false;
    waiter.resolve({
      workspace: waiter.workspace,
      waitedMs: Date.now() - waiter.enqueuedAt,
      release: () => {
        if (released) return;
        released = true;
        this.activeGlobal -= 1;
        const next = (this.activeByWorkspace.get(waiter.workspace) ?? 1) - 1;
        if (next <= 0) this.activeByWorkspace.delete(waiter.workspace);
        else this.activeByWorkspace.set(waiter.workspace, next);
        this.totalCompleted += 1;
        this.drain();
      }
    });
  }

  private drain(): void {
    while (this.activeGlobal < this.maxGlobal && this.rotation.length > 0) {
      const cycle = this.rotation.length;
      let granted = false;

      for (let i = 0; i < cycle && this.activeGlobal < this.maxGlobal; i++) {
        const workspace = this.rotation.shift()!;
        const queue = this.queues.get(workspace);

        if (!queue || queue.length === 0) {
          this.queues.delete(workspace);
          continue;
        }

        if (!this.canStart(workspace)) {
          this.rotation.push(workspace);
          continue;
        }

        const waiter = queue.shift()!;
        if (queue.length > 0) this.rotation.push(workspace);
        else this.queues.delete(workspace);

        this.grant(waiter);
        granted = true;
      }

      if (!granted) break;
    }
  }

  async acquire(workspace: string, timeoutMs = 15_000): Promise<Lease> {
    const key = workspace || "default";
    const hasQueuedWork = this.rotation.length > 0;

    if (!hasQueuedWork && this.canStart(key)) {
      return await new Promise<Lease>((resolve, reject) => {
        this.grant({ workspace: key, enqueuedAt: Date.now(), resolve, reject });
      });
    }

    return await new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = { workspace: key, enqueuedAt: Date.now(), resolve, reject };
      const queue = this.queues.get(key);
      if (queue) queue.push(waiter);
      else {
        this.queues.set(key, [waiter]);
        this.rotation.push(key);
      }

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const pending = this.queues.get(key);
          if (!pending) return;
          const index = pending.indexOf(waiter);
          if (index < 0) return;
          pending.splice(index, 1);
          if (pending.length === 0) {
            this.queues.delete(key);
            this.rotation = this.rotation.filter((item) => item !== key);
          }
          this.totalTimedOut += 1;
          reject(new Error(`Concurrency queue timeout in ${this.name} for workspace ${key} after ${timeoutMs}ms`));
          this.drain();
        }, timeoutMs);
        waiter.timer.unref();
      }

      this.drain();
    });
  }

  async run<T>(workspace: string, fn: (waitedMs: number) => Promise<T>, timeoutMs = 15_000): Promise<T> {
    const lease = await this.acquire(workspace, timeoutMs);
    try {
      return await fn(lease.waitedMs);
    } finally {
      lease.release();
    }
  }

  snapshot(): PoolSnapshot {
    return {
      name: this.name,
      maxGlobal: this.maxGlobal,
      maxPerWorkspace: this.maxPerWorkspace,
      activeGlobal: this.activeGlobal,
      queuedGlobal: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
      activeByWorkspace: Object.fromEntries(this.activeByWorkspace),
      queuedByWorkspace: Object.fromEntries([...this.queues].map(([key, queue]) => [key, queue.length])),
      totalStarted: this.totalStarted,
      totalCompleted: this.totalCompleted,
      totalTimedOut: this.totalTimedOut
    };
  }
}

export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  private queued = new Map<string, number>();

  private async acquireOne(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    this.queued.set(key, (this.queued.get(key) ?? 0) + 1);

    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      const next = (this.queued.get(key) ?? 1) - 1;
      if (next <= 0) this.queued.delete(key);
      else this.queued.set(key, next);
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    };
  }

  async withKeys<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const normalized = [...new Set(keys.map((key) => process.platform === "win32" ? key.toLowerCase() : key))].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of normalized) releases.push(await this.acquireOne(key));
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  snapshot(): { lockedKeys: number; queuedByKey: Record<string, number> } {
    return { lockedKeys: this.tails.size, queuedByKey: Object.fromEntries(this.queued) };
  }
}
