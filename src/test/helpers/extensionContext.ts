import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** A minimal fake ExtensionContext backed by a real scratch temp dir, so Controller's
 *  internal stores (UsageStore, ChatHistoryStore, ...) do real, fast, throwaway file I/O
 *  instead of requiring fs/promises to be globally mocked. */
export async function makeFakeContext() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-test-'));
  return {
    subscriptions: [] as { dispose(): void }[],
    globalStorageUri: { fsPath: dir },
    secrets: {
      get: async (_key: string) => undefined,
      store: async (_key: string, _value: string) => undefined,
    },
  };
}
