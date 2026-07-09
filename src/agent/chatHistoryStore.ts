import * as fs from 'fs/promises';
import * as path from 'path';

export interface ChatRecord {
  id: number;
  projectPath: string;
  projectName: string;
  title: string;
  model: string;
  backend: 'credits' | 'subscription';
  createdAt: number;
  updatedAt: number;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated plan value of subscription-backend usage (not billed as credits). */
  planCostUsd: number;
  /** Actual USD billed against the credits/API backend. */
  creditCostUsd: number;
  userChars: number;
  assistantChars: number;
}

export type ChatInit = Pick<ChatRecord, 'projectPath' | 'projectName' | 'title' | 'model' | 'backend' | 'createdAt'>;

export interface ChatUsageDelta {
  backend: 'credits' | 'subscription';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  assistantChars: number;
}

const MAX_CHATS = 2000;

/**
 * Persistent, cross-workspace log of every chat session (one Session = one
 * chat = one task) — for the "chat history" view: cost, length and duration
 * per chat, across all projects. Best-effort, same discipline as UsageStore.
 */
export class ChatHistoryStore {
  private chats = new Map<number, ChatRecord>();
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<ChatHistoryStore> {
    const store = new ChatHistoryStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const rec of parsed as (ChatRecord & { costUsd?: number })[]) {
          if (rec.planCostUsd === undefined || rec.creditCostUsd === undefined) {
            const legacyCost = rec.costUsd ?? 0;
            rec.planCostUsd = rec.backend === 'subscription' ? legacyCost : 0;
            rec.creditCostUsd = rec.backend === 'subscription' ? 0 : legacyCost;
          }
          delete rec.costUsd;
          store.chats.set(rec.id, rec);
        }
      }
    } catch {
      // no history yet, or unreadable — start fresh
    }
    return store;
  }

  /** Creates the chat record on first use of a session id; a no-op afterwards. */
  ensure(id: number, init: ChatInit): ChatRecord {
    let rec = this.chats.get(id);
    if (!rec) {
      rec = {
        id,
        ...init,
        updatedAt: init.createdAt,
        promptCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        planCostUsd: 0,
        creditCostUsd: 0,
        userChars: 0,
        assistantChars: 0,
      };
      this.chats.set(id, rec);
      this.pruneIfNeeded();
      this.markDirty();
    }
    return rec;
  }

  /** Once per user turn: bumps the message count and user-side length. */
  recordPrompt(id: number, userChars: number): void {
    const rec = this.chats.get(id);
    if (!rec) {
      return;
    }
    rec.promptCount += 1;
    rec.userChars += userChars;
    rec.updatedAt = Date.now();
    this.markDirty();
  }

  /** Once per API request (a turn can span several in a tool-use loop). */
  addUsage(id: number, delta: ChatUsageDelta): void {
    const rec = this.chats.get(id);
    if (!rec) {
      return;
    }
    rec.inputTokens += delta.inputTokens;
    rec.outputTokens += delta.outputTokens;
    rec.cacheReadTokens += delta.cacheReadTokens;
    rec.cacheWriteTokens += delta.cacheWriteTokens;
    if (delta.backend === 'subscription') {
      rec.planCostUsd += delta.costUsd;
    } else {
      rec.creditCostUsd += delta.costUsd;
    }
    rec.assistantChars += delta.assistantChars;
    rec.updatedAt = Date.now();
    this.markDirty();
  }

  all(): ChatRecord[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  forProject(projectPath: string): ChatRecord[] {
    return this.all().filter((r) => r.projectPath === projectPath);
  }

  reset(): void {
    this.chats.clear();
    this.markDirty();
  }

  private pruneIfNeeded(): void {
    if (this.chats.size <= MAX_CHATS) {
      return;
    }
    const oldest = [...this.chats.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const rec of oldest.slice(0, this.chats.size - MAX_CHATS)) {
      this.chats.delete(rec.id);
    }
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
