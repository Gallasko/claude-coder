import * as fs from 'fs/promises';
import * as path from 'path';

export interface ProjectRecord {
  path: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistent, cross-workspace registry of every project (workspace folder)
 * Claude Coder has run in — the "projects" side of the history view, so
 * chats and summaries (both keyed by projectPath) can be grouped per project.
 */
export class ProjectStore {
  private projects = new Map<string, ProjectRecord>();
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<ProjectStore> {
    const store = new ProjectStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const rec of parsed as ProjectRecord[]) {
          store.projects.set(rec.path, rec);
        }
      }
    } catch {
      // no projects yet, or unreadable — start fresh
    }
    return store;
  }

  /** Registers a project on first sight, else just bumps updatedAt. */
  ensure(projectPath: string, name: string): ProjectRecord {
    const now = Date.now();
    let rec = this.projects.get(projectPath);
    if (!rec) {
      rec = { path: projectPath, name, createdAt: now, updatedAt: now };
      this.projects.set(projectPath, rec);
    } else {
      rec.updatedAt = now;
    }
    this.markDirty();
    return rec;
  }

  all(): ProjectRecord[] {
    return [...this.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
      await fs.writeFile(this.filePath, JSON.stringify(this.all()), 'utf8');
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }
}
