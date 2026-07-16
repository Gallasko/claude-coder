import * as fs from 'fs/promises';
import * as path from 'path';

export interface MessageRecord {
  id: number;
  chatId: number;
  projectPath: string;
  role: 'user' | 'assistant' | 'tool' | 'thinking';
  text: string;
  createdAt: number;
}

const MAX_MESSAGES = 20000;

/**
 * Persistent, cross-workspace log of every user/assistant turn's text —
 * the raw transcript backing the chat-history detail view (SummaryStore
 * holds the AI's end-of-task reflections, this holds what was actually
 * said). Append-only, best-effort, same discipline as SummaryStore.
 */
export class MessageStore {
  private messages: MessageRecord[] = [];
  private nextId = 1;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(private filePath: string) {}

  static async load(filePath: string): Promise<MessageStore> {
    const store = new MessageStore(filePath);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.messages)) {
        store.messages = parsed.messages;
      }
      store.nextId = parsed.nextId ?? store.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    } catch {
      // no messages yet, or unreadable — start fresh
    }
    return store;
  }

  add(rec: Omit<MessageRecord, 'id' | 'createdAt'>): MessageRecord {
    const message: MessageRecord = { ...rec, id: this.nextId++, createdAt: Date.now() };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.markDirty();
    return message;
  }

  forChat(chatId: number): MessageRecord[] {
    return this.messages.filter((m) => m.chatId === chatId).sort((a, b) => a.createdAt - b.createdAt);
  }

  reset(): void {
    this.messages = [];
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
      await fs.writeFile(this.filePath, JSON.stringify({ nextId: this.nextId, messages: this.messages }), 'utf8');
    } catch {
      // best-effort persistence; never block the agent on a disk error
    }
  }
}
