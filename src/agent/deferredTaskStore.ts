import * as fs from 'fs/promises';
import * as path from 'path';

export interface DeferredTask {
  id: number;
  /** Original user prompt text (pre-preamble) — re-injected verbatim on resume. */
  prompt: string;
  /** ISO timestamp of the plan-limit reset the task is waiting for. */
  resetsAt: string;
  createdAt: number;
  status: 'pending' | 'resumed' | 'cancelled';
}

/**
 * Persistent, per-workspace store of tasks deferred until the subscription
 * plan limit resets. Mirrors TaskMemoryStore's queued-write pattern with an
 * atomic tmp+rename save so a pending task survives VS Code restarts.
 */
export class DeferredTaskStore {
  private tasks: DeferredTask[] = [];
  private nextId = 1;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<DeferredTaskStore> {
    const store = new DeferredTaskStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tasks)) {
        store.tasks = parsed.tasks;
      }
      store.nextId = parsed.nextId ?? store.tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    } catch {
      // no deferred tasks yet, or unreadable — start fresh
    }
    return store;
  }

  add(prompt: string, resetsAt: string): DeferredTask {
    const task: DeferredTask = { id: this.nextId++, prompt, resetsAt, createdAt: Date.now(), status: 'pending' };
    this.tasks.push(task);
    this.markDirty();
    return task;
  }

  pending(): DeferredTask[] {
    return this.tasks.filter((t) => t.status === 'pending');
  }

  /** Pending tasks whose reset time has passed, oldest first. */
  due(now: number): DeferredTask[] {
    return this.pending()
      .filter((t) => Date.parse(t.resetsAt) <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  markResumed(id: number): void {
    const task = this.tasks.find((t) => t.id === id);
    if (task) {
      task.status = 'resumed';
      this.markDirty();
    }
  }

  cancel(id: number): boolean {
    const task = this.tasks.find((t) => t.id === id && t.status === 'pending');
    if (!task) {
      return false;
    }
    task.status = 'cancelled';
    this.markDirty();
    return true;
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
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ nextId: this.nextId, tasks: this.tasks }), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }
}
