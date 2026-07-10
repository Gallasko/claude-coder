import * as fs from 'fs/promises';
import * as path from 'path';

export interface FileRecord {
  hash: string;
  lastReadAt: number;
  /** Size/mtime the last summary was generated against — the freshness key (cheaper than re-hashing to check). */
  size?: number;
  mtimeMs?: number;
  summary?: string;
  summarizedAt?: number;
  /** How many times this file has been read (raw reads and served-from-cache reads both count) — drives detailed-summary upgrades. */
  readCount?: number;
  /** Whether the cached summary is the quick digest or the fuller digest generated for frequently-read files. */
  summaryDetail?: 'concise' | 'detailed';
}

export interface FileSummaryEntry extends FileRecord {
  path: string;
}

export interface ChangeRecord {
  taskId: string;
  taskSummary: string;
  path: string;
  tool: 'write_file' | 'edit_file' | 'multi_edit_file';
  before: string;
  after: string;
  timestamp: number;
}

export interface MemoryNote {
  id: number;
  text: string;
  createdAt: number;
}

interface MemoryData {
  files: Record<string, FileRecord>;
  changes: ChangeRecord[];
  notes: MemoryNote[];
  nextNoteId: number;
}

const MAX_CHANGES = 500;
const MAX_NOTES = 200;

/**
 * Persistent, per-workspace local cache: file read hashes + an edit history.
 * Pure local state, never sent to the API verbatim — only a short digest of
 * it goes into the first-message preamble (see controller.ts). Lets a new
 * task start with "what's already known/changed" instead of the model
 * re-deriving it through read/glob/grep round trips.
 */
export class MemoryStore {
  private data: MemoryData = { files: {}, changes: [], notes: [], nextNoteId: 1 };
  private dirty = false;

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<MemoryStore> {
    const store = new MemoryStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      store.data = {
        files: parsed.files ?? {},
        changes: parsed.changes ?? [],
        notes: parsed.notes ?? [],
        nextNoteId: parsed.nextNoteId ?? 1,
      };
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
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }

  /** Records a real (non-cached) read; preserves the existing summary/readCount. Returns the updated read count. */
  noteRead(filePath: string, hash: string): number {
    const existing = this.data.files[filePath];
    const readCount = (existing?.readCount ?? 0) + 1;
    this.data.files[filePath] = { ...existing, hash, lastReadAt: Date.now(), readCount };
    this.dirty = true;
    void this.save();
    return readCount;
  }

  /** Bumps the read count for a file served from the summary cache (no real read happened). Returns the updated read count. */
  bumpReadCount(filePath: string): number {
    const existing = this.data.files[filePath];
    const readCount = (existing?.readCount ?? 0) + 1;
    this.data.files[filePath] = {
      ...existing,
      hash: existing?.hash ?? '',
      lastReadAt: existing?.lastReadAt ?? Date.now(),
      readCount,
    };
    this.dirty = true;
    void this.save();
    return readCount;
  }

  getFileRecord(filePath: string): FileRecord | undefined {
    return this.data.files[filePath];
  }

  /** Returns the cached summary only if it was generated against this exact size+mtime — otherwise stale/missing. */
  freshSummary(filePath: string, mtimeMs: number, size: number): string | undefined {
    const rec = this.data.files[filePath];
    return rec?.summary && rec.mtimeMs === mtimeMs && rec.size === size ? rec.summary : undefined;
  }

  /** Persists a lazily-generated file summary, keyed to the size+mtime it was generated against. */
  saveSummary(filePath: string, mtimeMs: number, size: number, summary: string, detail: 'concise' | 'detailed' = 'concise'): void {
    const existing = this.data.files[filePath];
    this.data.files[filePath] = {
      hash: existing?.hash ?? '',
      lastReadAt: existing?.lastReadAt ?? Date.now(),
      readCount: existing?.readCount,
      size,
      mtimeMs,
      summary,
      summaryDetail: detail,
      summarizedAt: Date.now(),
    };
    this.dirty = true;
    void this.save();
  }

  /** All cached file summaries, most recently generated first — for the /memory view. */
  listSummaries(limit = 100): FileSummaryEntry[] {
    return Object.entries(this.data.files)
      .filter(([, r]) => !!r.summary)
      .map(([path, r]) => ({ path, ...r }))
      .sort((a, b) => (b.summarizedAt ?? 0) - (a.summarizedAt ?? 0))
      .slice(0, limit);
  }

  /** Drops the record for a file that no longer exists on disk (see controller.ts showMemory pruning). */
  forgetFile(filePath: string): void {
    if (delete this.data.files[filePath]) {
      this.dirty = true;
      void this.save();
    }
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

  /** Freeform notes the user chose to remember about this project (manual, not auto-derived). */
  addNote(text: string): MemoryNote {
    const note: MemoryNote = { id: this.data.nextNoteId++, text, createdAt: Date.now() };
    this.data.notes.push(note);
    if (this.data.notes.length > MAX_NOTES) {
      this.data.notes.splice(0, this.data.notes.length - MAX_NOTES);
    }
    this.dirty = true;
    void this.save();
    return note;
  }

  listNotes(limit = 50): MemoryNote[] {
    return this.data.notes.slice(-limit).reverse();
  }

  deleteNote(id: number): boolean {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    if (this.data.notes.length !== before) {
      this.dirty = true;
      void this.save();
      return true;
    }
    return false;
  }

  /** Compact, zero-API-cost text for the first-message preamble. */
  projectDigest(limit = 8): string {
    const notes = this.listNotes(limit);
    const changes = this.recentChanges(limit);
    const parts: string[] = [];
    if (notes.length > 0) {
      parts.push(`Project memory notes:\n${notes.map((n) => `- ${n.text}`).join('\n')}`);
    }
    if (changes.length > 0) {
      parts.push(
        `Recent changes in this project (local memory, most recent first):\n${changes
          .map((c) => `- ${c.path} (${c.tool}, task: ${c.taskSummary || 'unknown'})`)
          .join('\n')}`
      );
    }
    return parts.join('\n\n');
  }
}
