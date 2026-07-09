import * as fs from 'fs/promises';
import * as path from 'path';

export type UsageKind = 'turn' | 'classify' | 'compress' | 'compact' | 'plan' | 'subscription' | 'summarize' | 'recall';

export interface UsageRecord {
  timestamp: number;
  model: string;
  backend: 'credits' | 'subscription';
  kind: UsageKind;
  sessionId: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface Aggregate {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  creditsCostUsd: number;
  subscriptionEstValueUsd: number;
  byDay: Aggregate[];
  byModel: Aggregate[];
}

export type Granularity = 'hour' | 'day' | 'week';

export interface Bucket {
  /** Human-readable label for this bucket's start, in local time. */
  key: string;
  /** Epoch ms of the bucket's start (local-time aligned). */
  start: number;
  requests: number;
  costUsd: number;
}

const BUCKET_COUNT: Record<Granularity, number> = { hour: 24, day: 14, week: 8 };

const MAX_RECORDS = 5000;

/**
 * Persistent, cross-workspace log of every API/subscription request this
 * extension has made, for the "usage history / billing" view. Best-effort:
 * a disk error here must never interrupt an in-flight turn.
 */
export class UsageStore {
  private records: UsageRecord[] = [];
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<UsageStore> {
    const store = new UsageStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        store.records = parsed;
      }
    } catch {
      // no history yet, or unreadable — start fresh
    }
    return store;
  }

  record(entry: Omit<UsageRecord, 'timestamp'>): void {
    this.records.push({ ...entry, timestamp: Date.now() });
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
    this.dirty = true;
    this.queueSave();
  }

  reset(): void {
    this.records = [];
    this.dirty = true;
    this.queueSave();
  }

  all(): readonly UsageRecord[] {
    return this.records;
  }

  recent(limit = 100): UsageRecord[] {
    return this.records.slice(-limit).reverse();
  }

  summary(): UsageSummary {
    const byDay = new Map<string, Aggregate>();
    const byModel = new Map<string, Aggregate>();
    let creditsCostUsd = 0;
    let subscriptionEstValueUsd = 0;
    let totalTokens = 0;

    for (const r of this.records) {
      const day = new Date(r.timestamp).toISOString().slice(0, 10);
      bump(byDay, day, r);
      bump(byModel, r.model, r);
      totalTokens += r.inputTokens + r.outputTokens;
      if (r.backend === 'subscription') {
        subscriptionEstValueUsd += r.costUsd;
      } else {
        creditsCostUsd += r.costUsd;
      }
    }

    return {
      totalRequests: this.records.length,
      totalTokens,
      creditsCostUsd,
      subscriptionEstValueUsd,
      byDay: [...byDay.values()].sort((a, b) => (a.key < b.key ? 1 : -1)),
      byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    };
  }

  /**
   * Fixed-width, local-time-aligned buckets ending at "now": last 24 hours
   * (hourly), last 14 days (daily), or last 8 weeks (weekly, Monday-aligned).
   * Empty buckets are included so gaps in usage are visible on the graph.
   */
  buckets(granularity: Granularity): Bucket[] {
    const count = BUCKET_COUNT[granularity];
    const stepMs = granularity === 'hour' ? 3_600_000 : granularity === 'day' ? 86_400_000 : 7 * 86_400_000;
    const nowStart = bucketStart(Date.now(), granularity);
    const starts: number[] = [];
    for (let i = count - 1; i >= 0; i--) {
      starts.push(nowStart - i * stepMs);
    }

    const byStart = new Map<number, Bucket>();
    for (const s of starts) {
      byStart.set(s, { key: bucketLabel(s, granularity), start: s, requests: 0, costUsd: 0 });
    }

    const minStart = starts[0];
    for (const r of this.records) {
      if (r.timestamp < minStart) {
        continue;
      }
      const bucket = byStart.get(bucketStart(r.timestamp, granularity));
      if (bucket) {
        bucket.requests += 1;
        bucket.costUsd += r.costUsd;
      }
    }

    return starts.map((s) => byStart.get(s)!);
  }

  /** Serializes writes so concurrent record() calls never clobber each other on disk. */
  private queueSave(): void {
    this.saveChain = this.saveChain.then(() => this.save());
  }

  private async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.records), 'utf8');
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }
}

/** Aligns a timestamp down to the start of its bucket, in local time. */
function bucketStart(ts: number, granularity: Granularity): number {
  const d = new Date(ts);
  if (granularity === 'hour') {
    d.setMinutes(0, 0, 0);
  } else if (granularity === 'day') {
    d.setHours(0, 0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
    const dayOfWeek = d.getDay(); // 0 = Sunday
    const sinceMonday = (dayOfWeek + 6) % 7;
    d.setDate(d.getDate() - sinceMonday);
  }
  return d.getTime();
}

function bucketLabel(start: number, granularity: Granularity): string {
  const d = new Date(start);
  if (granularity === 'hour') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function bump(map: Map<string, Aggregate>, key: string, r: UsageRecord): void {
  const agg = map.get(key) ?? {
    key,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  agg.requests += 1;
  agg.inputTokens += r.inputTokens;
  agg.outputTokens += r.outputTokens;
  agg.cacheReadTokens += r.cacheReadTokens;
  agg.cacheWriteTokens += r.cacheWriteTokens;
  agg.costUsd += r.costUsd;
  map.set(key, agg);
}
