import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('write_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-writefile-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a new file and records a "(new file)" before-state', async () => {
    const memory = { ...makeCtx({ workspaceRoot: dir }).memory };
    const noteChange = vi.fn();
    const ctx = makeCtx({ workspaceRoot: dir, memory: { ...memory, noteChange } as any });
    const outcome = await executeTool(ctx, 'write_file', { path: 'new.txt', content: 'hello' });
    expect(outcome.isError).toBe(false);
    expect(await fs.readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('hello');
    expect(noteChange).toHaveBeenCalledWith(expect.objectContaining({ before: '(new file)' }));
  });

  it('passes the prior content as "before" when overwriting an existing file', async () => {
    await fs.writeFile(path.join(dir, 'existing.txt'), 'old content', 'utf8');
    const requestEditApproval = vi.fn(async () => true);
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval });
    const outcome = await executeTool(ctx, 'write_file', { path: 'existing.txt', content: 'new content' });
    expect(outcome.isError).toBe(false);
    expect(requestEditApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'edit' }),
      'old content',
      'new content',
      expect.any(String),
      true
    );
  });

  it('denies the write and leaves the file untouched', async () => {
    await fs.writeFile(path.join(dir, 'existing.txt'), 'old content', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval: vi.fn(async () => false) });
    const outcome = await executeTool(ctx, 'write_file', { path: 'existing.txt', content: 'new content' });
    expect(outcome.isError).toBe(true);
    expect(await fs.readFile(path.join(dir, 'existing.txt'), 'utf8')).toBe('old content');
  });

  it('requests outside-write approval for a path outside the workspace', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-outside-'));
    const requestEditApproval = vi.fn(async () => true);
    const ctx = makeCtx({ workspaceRoot: dir, requestEditApproval });
    await executeTool(ctx, 'write_file', { path: path.join(outsideDir, 'f.txt'), content: 'x' });
    expect(requestEditApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'outside-write' }),
      expect.any(String),
      'x',
      expect.any(String),
      false
    );
  });

  it('auto-creates parent directories for a nested path', async () => {
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'write_file', { path: 'a/b/c/d.txt', content: 'nested' });
    expect(outcome.isError).toBe(false);
    expect(await fs.readFile(path.join(dir, 'a/b/c/d.txt'), 'utf8')).toBe('nested');
  });
});
