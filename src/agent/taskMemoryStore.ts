import * as fs from 'fs/promises';
import * as path from 'path';

export interface TaskMemoryFile {
  mtimeMs: number;
  size: number;
}

export interface TaskMemory {
  id: number;
  projectPath: string;
  /** Task summary/title, e.g. session.taskSummary at creation time. */
  title: string;
  /** What/why/how — refreshed every few prompts and at task end (see summarizer.ts createTaskMemory). */
  summary: string;
  /** Files touched while this memory was built, keyed by workspace-relative path — the freshness keys. */
  files: Record<string, TaskMemoryFile>;
  chatIds: number[];
  createdAt: number;
  updatedAt: number;
  /** Paths whose on-disk mtime/size no longer match `files` — edited outside the extension since this memory was last refreshed. */
  staleFiles?: string[];
}

const MAX_MEMORIES_PER_PROJECT = 200;

/**
 * Persistent, per-workspace store of task-level memories: what was done and
 * which files it touched, so a later task on the same project can reuse the
 * summary as context instead of rediscovering the code through read/glob/grep
 * round trips. Mirrors SummaryStore's queued-write pattern combined with
 * MemoryStore's atomic tmp+rename save (written more often than the
 * append-only chat-summary log, so corruption-safety matters more here).
 */
export class TaskMemoryStore {
  private memories: TaskMemory[] = [];
  private nextId = 1;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<TaskMemoryStore> {
    const store = new TaskMemoryStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.memories)) {
        store.memories = parsed.memories;
      }
      store.nextId = parsed.nextId ?? store.memories.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    } catch {
      // no task memories yet, or unreadable — start fresh
    }
    return store;
  }

  add(rec: Omit<TaskMemory, 'id' | 'createdAt' | 'updatedAt'>): TaskMemory {
    const now = Date.now();
    const memory: TaskMemory = { ...rec, id: this.nextId++, createdAt: now, updatedAt: now };
    this.memories.push(memory);
    this.trimProject(memory.projectPath);
    this.markDirty();
    return memory;
  }

  update(id: number, patch: Partial<Omit<TaskMemory, 'id' | 'projectPath' | 'createdAt'>>): TaskMemory | undefined {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) {
      return undefined;
    }
    Object.assign(memory, patch, { updatedAt: Date.now() });
    this.markDirty();
    return memory;
  }

  get(id: number): TaskMemory | undefined {
    return this.memories.find((m) => m.id === id);
  }

  forProject(projectPath: string, limit?: number): TaskMemory[] {
    const list = this.memories.filter((m) => m.projectPath === projectPath).sort((a, b) => b.updatedAt - a.updatedAt);
    return limit ? list.slice(0, limit) : list;
  }

  /** Memories in a project whose tracked files intersect the given paths. */
  findByTouchedFiles(projectPath: string, paths: string[]): TaskMemory[] {
    const set = new Set(paths);
    return this.forProject(projectPath).filter((m) => Object.keys(m.files).some((f) => set.has(f)));
  }

  private trimProject(projectPath: string): void {
    const forProject = this.memories.filter((m) => m.projectPath === projectPath);
    if (forProject.length <= MAX_MEMORIES_PER_PROJECT) {
      return;
    }
    const excess = forProject.length - MAX_MEMORIES_PER_PROJECT;
    const oldestIds = new Set(
      forProject
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, excess)
        .map((m) => m.id)
    );
    this.memories = this.memories.filter((m) => !oldestIds.has(m.id));
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
      await fs.writeFile(tmp, JSON.stringify({ nextId: this.nextId, memories: this.memories }), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }
}
