import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('read_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-readfile-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('denies a read outside the workspace when permission is refused', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-outside-'));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'top secret', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir, requestPermission: vi.fn(async () => false) });
    const outcome = await executeTool(ctx, 'read_file', { path: path.join(outsideDir, 'secret.txt') });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('denied permission');
  });

  it('reads a file outside the workspace once permission is granted', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-outside-'));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'top secret content', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir, requestPermission: vi.fn(async () => true) });
    const outcome = await executeTool(ctx, 'read_file', { path: path.join(outsideDir, 'secret.txt') });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('top secret content');
  });

  it('serves a cached summary on a whole-file read cache hit, not the raw content', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const uniqueRawMarker = 1;', 'utf8');
    const memory = {
      whenSaved: vi.fn(async () => undefined),
      freshSummary: vi.fn(() => 'the cached summary text'),
      bumpReadCount: vi.fn(() => 1),
      getFileRecord: vi.fn(() => ({ summaryDetail: 'concise' })),
      noteRead: vi.fn(() => 1),
      saveSummary: vi.fn(),
      noteChange: vi.fn(),
    };
    const ctx = makeCtx({ workspaceRoot: dir, memory: memory as any });
    const outcome = await executeTool(ctx, 'read_file', { path: 'a.ts' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('the cached summary text');
    expect(outcome.content).not.toContain('uniqueRawMarker');
  });

  it('short-circuits a whole-file read already sent earlier in the session', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    // First read populates readCache with the file's hash.
    const first = await executeTool(ctx, 'read_file', { path: 'a.ts' });
    expect(first.isError).toBe(false);
    const second = await executeTool(ctx, 'read_file', { path: 'a.ts' });
    expect(second.isError).toBe(false);
    expect(second.content).toContain('unchanged since it was read in full earlier in this session');
  });

  it('returns numbered lines with a truncation footer for a partial read', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(path.join(dir, 'b.ts'), lines, 'utf8');
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'read_file', { path: 'b.ts', offset: 2, limit: 3 });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('2\tline 2');
    expect(outcome.content).toContain('3\tline 3');
    expect(outcome.content).toContain('4\tline 4');
    expect(outcome.content).not.toContain('5\tline 5');
    expect(outcome.content).toContain('[showing lines 2-4 of 20]');
  });

  it('condenses a large whole-file read via preprocessRead on a planner ctx', async () => {
    const big = 'x'.repeat(3000);
    await fs.writeFile(path.join(dir, 'big.ts'), big, 'utf8');
    const preprocessRead = vi.fn(async () => 'condensed output');
    const ctx = makeCtx({ workspaceRoot: dir, preprocessRead });
    const outcome = await executeTool(ctx, 'read_file', { path: 'big.ts' });
    expect(outcome.isError).toBe(false);
    expect(preprocessRead).toHaveBeenCalled();
    expect(outcome.content).toContain('condensed for planning');
    expect(outcome.content).toContain('condensed output');
  });
});
