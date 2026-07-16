import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('multi_edit_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-multiedit-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('throws immediately on an empty edits array, without reading the file', async () => {
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'multi_edit_file', { path: 'missing.ts', edits: [] });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('non-empty array');
  });

  it('applies edits in order, each depending on the previous', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'multi_edit_file', {
      path: 'a.ts',
      edits: [
        { old_string: 'const x = 1;', new_string: 'const x = 2;' },
        { old_string: 'const x = 2;', new_string: 'const x = 3;' },
      ],
    });
    expect(outcome.isError).toBe(false);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const x = 3;');
  });

  it('throws with the failing edit index and leaves the file unchanged on disk', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'multi_edit_file', {
      path: 'a.ts',
      edits: [
        { old_string: 'const x = 1;', new_string: 'const x = 2;' },
        { old_string: 'const x = 1;', new_string: 'const x = 9;' }, // no longer present after edit 1
      ],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('for edit 2');
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const x = 1;');
  });

  it('throws with the failing edit index on an ambiguous match', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'dup\ndup', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'multi_edit_file', {
      path: 'a.ts',
      edits: [{ old_string: 'dup', new_string: 'x' }],
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('for edit 1');
  });

  it('denies the whole batch and leaves the file unchanged', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval: vi.fn(async () => false) });
    const outcome = await executeTool(ctx, 'multi_edit_file', {
      path: 'a.ts',
      edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }],
    });
    expect(outcome.isError).toBe(true);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const x = 1;');
  });
});
