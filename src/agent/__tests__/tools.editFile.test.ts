import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('edit_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-editfile-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('replaces a single unique match', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = 99;' });
    expect(outcome.isError).toBe(false);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const x = 99;\nconst y = 2;');
  });

  it('throws when old_string is not found, without requesting approval', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
    const requestEditApproval = vi.fn(async () => true);
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval });
    const outcome = await executeTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'missing', new_string: 'x' });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('old_string not found');
    expect(requestEditApproval).not.toHaveBeenCalled();
  });

  it('throws with the match count when old_string is ambiguous', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'dup\ndup\ndup', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'dup', new_string: 'x' });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('appears 3 times');
  });

  it('replaces every occurrence when replace_all is set', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'dup\ndup\ndup', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'dup', new_string: 'x', replace_all: true });
    expect(outcome.isError).toBe(false);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('x\nx\nx');
  });

  it('denies the edit and leaves the file unchanged', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval: vi.fn(async () => false) });
    const outcome = await executeTool(ctx, 'edit_file', { path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' });
    expect(outcome.isError).toBe(true);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('const x = 1;');
  });

  it('requests outside-write approval for a path outside the workspace', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-outside-'));
    await fs.writeFile(path.join(outsideDir, 'f.txt'), 'hello world', 'utf8');
    const requestEditApproval = vi.fn(async () => true);
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval });
    await executeTool(ctx, 'edit_file', { path: path.join(outsideDir, 'f.txt'), old_string: 'hello', new_string: 'goodbye' });
    expect(requestEditApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'outside-write' }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      true
    );
  });
});
