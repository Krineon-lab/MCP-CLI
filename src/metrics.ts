interface ToolMetric {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  totalQueueWaitMs: number;
  maxQueueWaitMs: number;
  lastAt: string;
}

class MetricsRegistry {
  private startedAt = Date.now();
  private tools = new Map<string, ToolMetric>();

  record(tool: string, durationMs: number, error: boolean, queueWaitMs = 0): void {
    const metric = this.tools.get(tool) ?? {
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      totalQueueWaitMs: 0,
      maxQueueWaitMs: 0,
      lastAt: ""
    };
    metric.calls += 1;
    if (error) metric.errors += 1;
    metric.totalMs += durationMs;
    metric.maxMs = Math.max(metric.maxMs, durationMs);
    metric.lastMs = durationMs;
    metric.totalQueueWaitMs += queueWaitMs;
    metric.maxQueueWaitMs = Math.max(metric.maxQueueWaitMs, queueWaitMs);
    metric.lastAt = new Date().toISOString();
    this.tools.set(tool, metric);
  }

  snapshot() {
    return {
      since: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      tools: Object.fromEntries(
        [...this.tools.entries()].map(([name, m]) => [name, {
          calls: m.calls,
          errors: m.errors,
          avgMs: m.calls ? Math.round((m.totalMs / m.calls) * 10) / 10 : 0,
          maxMs: Math.round(m.maxMs * 10) / 10,
          lastMs: Math.round(m.lastMs * 10) / 10,
          avgQueueWaitMs: m.calls ? Math.round((m.totalQueueWaitMs / m.calls) * 10) / 10 : 0,
          maxQueueWaitMs: Math.round(m.maxQueueWaitMs * 10) / 10,
          lastAt: m.lastAt
        }])
      )
    };
  }
}

export const metrics = new MetricsRegistry();
