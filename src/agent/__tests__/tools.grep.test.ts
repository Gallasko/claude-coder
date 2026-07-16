import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';
import { __state, __reset, Uri } from '../../test/mocks/vscode';

describe('grep', () => {
  let dir: string;

  beforeEach(async () => {
    __reset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-grep-'));
    __state.workspaceFolders = [{ uri: { fsPath: dir } }];
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns path:line:text matches, trimmed', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), '  const needle = 1;\nconst other = 2;', 'utf8');
    __state.findFilesResult = [Uri.file(path.join(dir, 'a.ts'))];
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'grep', { pattern: 'needle' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('a.ts:1:const needle = 1;');
  });

  it('throws on an invalid regex', async () => {
    __state.findFilesResult = [];
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'grep', { pattern: '(' });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('Invalid regex');
  });

  it('excludes binary files even if findFiles returns them', async () => {
    await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    __state.findFilesResult = [Uri.file(path.join(dir, 'bin.dat'))];
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'grep', { pattern: 'needle' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('No matches.');
  });

  it('excludes files larger than 1MB', async () => {
    await fs.writeFile(path.join(dir, 'huge.ts'), 'needle\n' + 'x'.repeat(1_100_000));
    __state.findFilesResult = [Uri.file(path.join(dir, 'huge.ts'))];
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'grep', { pattern: 'needle' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('No matches.');
  });

  it('reports no matches', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'nothing here', 'utf8');
    __state.findFilesResult = [Uri.file(path.join(dir, 'a.ts'))];
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'grep', { pattern: 'needle' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('No matches.');
  });

  it('caps at 150 matches with a header', async () => {
    const lines = Array.from({ length: 200 }, () => 'needle').join('\n');
    await fs.writeFile(path.join(dir, 'many.ts'), lines, 'utf8');
    __state.findFilesResult = [Uri.file(path.join(dir, 'many.ts'))];
    const ctx = makeCtx({ workspaceRoot: dir });
    const outcome = await executeTool(ctx, 'grep', { pattern: 'needle' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('[first 150 matches]');
    expect(outcome.content.match(/needle/g)?.length).toBe(150);
  });
});
