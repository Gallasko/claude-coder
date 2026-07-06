import * as fs from 'fs/promises';
import * as path from 'path';

export interface FileRecord {
  hash: string;
  lastReadAt: number;
}

export interface ChangeRecord {
  taskId: string;
  taskSummary: string;
  path: string;
  tool: 'write_file' | 'edit_file';
  before: string;
  after: string;
  timestamp: number;
}

interface MemoryData {
  files: Record<string, FileRecord>;
  changes: ChangeRecord[];
}

const MAX_CHANGES = 500;

/**
 * Persistent, per-workspace local cache: file read hashes + an edit history.
 * Pure local state, never sent to the API verbatim — only a short digest of
 * it goes into the first-message preamble (see controller.ts). Lets a new
 * task start with "what's already known/changed" instead of the model
 * re-deriving it through read/glob/grep round trips.
 */
export class MemoryStore {
  private data: MemoryData = { files: {}, changes: [] };
  private dirty = false;

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<MemoryStore> {
    const store = new MemoryStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      store.data = JSON.parse(raw);
    } catch {
      // no memory yet, or unreadable — start fresh
    }
    return store;
  }

  private async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data), 'utf8');
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }

  noteRead(filePath: string, hash: string): void {
    this.data.files[filePath] = { hash, lastReadAt: Date.now() };
    this.dirty = true;
    void this.save();
  }

  getFileRecord(filePath: string): FileRecord | undefined {
    return this.data.files[filePath];
  }

  noteChange(change: Omit<ChangeRecord, 'timestamp'>): void {
    this.data.changes.push({ ...change, timestamp: Date.now() });
    if (this.data.changes.length > MAX_CHANGES) {
      this.data.changes.splice(0, this.data.changes.length - MAX_CHANGES);
    }
    this.dirty = true;
    void this.save();
  }

  recentChanges(limit = 15): ChangeRecord[] {
    return this.data.changes.slice(-limit).reverse();
  }

  /** Compact, zero-API-cost text for the first-message preamble. */
  projectDigest(limit = 8): string {
    const changes = this.recentChanges(limit);
    if (changes.length === 0) {
      return '';
    }
    const lines = changes.map((c) => `- ${c.path} (${c.tool}, task: ${c.taskSummary || 'unknown'})`);
    return `Recent changes in this project (local memory, most recent first):\n${lines.join('\n')}`;
  }
}
