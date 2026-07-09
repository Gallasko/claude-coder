import * as fs from 'fs/promises';
import * as path from 'path';

export interface SummaryRecord {
  id: number;
  chatId: number;
  projectPath: string;
  model: string;
  summary: string;
  highlights: string[];
  createdAt: number;
}

const MAX_SUMMARIES = 2000;

/**
 * Persistent, cross-workspace log of end-of-task summaries — one entry per
 * finished chat, produced by a cheap Haiku call (see summarizer.ts). This is
 * the "chat memory": what actually happened in each chat, grouped by
 * project (projectPath) and chat (chatId). Append-only, so re-summarizing a
 * chat keeps its older summaries instead of overwriting them.
 */
export class SummaryStore {
  private summaries: SummaryRecord[] = [];
  private nextId = 1;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<SummaryStore> {
    const store = new SummaryStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.summaries)) {
        store.summaries = parsed.summaries;
      }
      store.nextId = parsed.nextId ?? store.summaries.reduce((max, s) => Math.max(max, s.id), 0) + 1;
    } catch {
      // no summaries yet, or unreadable — start fresh
    }
    return store;
  }

  add(rec: Omit<SummaryRecord, 'id' | 'createdAt'>): SummaryRecord {
    const summary: SummaryRecord = { ...rec, id: this.nextId++, createdAt: Date.now() };
    this.summaries.push(summary);
    if (this.summaries.length > MAX_SUMMARIES) {
      this.summaries.splice(0, this.summaries.length - MAX_SUMMARIES);
    }
    this.markDirty();
    return summary;
  }

  forChat(chatId: number): SummaryRecord[] {
    return this.summaries.filter((s) => s.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt);
  }

  latestForChat(chatId: number): SummaryRecord | undefined {
    return this.forChat(chatId)[0];
  }

  forProject(projectPath: string): SummaryRecord[] {
    return this.summaries.filter((s) => s.projectPath === projectPath).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Most recent summary per distinct chat in a project — for seeding a new chat's context. */
  latestForProject(projectPath: string, limit = 5): SummaryRecord[] {
    const seen = new Set<number>();
    const result: SummaryRecord[] = [];
    for (const s of this.forProject(projectPath)) {
      if (seen.has(s.chatId)) {
        continue;
      }
      seen.add(s.chatId);
      result.push(s);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  reset(): void {
    this.summaries = [];
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    this.queueSave();
  }

  /** Serializes writes so concurrent updates never clobber each other on disk. */
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
      await fs.writeFile(this.filePath, JSON.stringify({ nextId: this.nextId, summaries: this.summaries }), 'utf8');
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }
}
