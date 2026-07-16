import { describe, it, expect, beforeEach } from 'vitest';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';
import { __state, __reset, Uri, workspace } from '../../test/mocks/vscode';

describe('glob', () => {
  beforeEach(() => {
    __reset();
  });

  it('returns relative paths, one per line, in order', async () => {
    __state.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    __state.findFilesResult = [Uri.file('/workspace/src/a.ts'), Uri.file('/workspace/src/b.ts')];
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'glob', { pattern: 'src/**/*.ts' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('src/a.ts\nsrc/b.ts');
  });

  it('reports no matches', async () => {
    __state.findFilesResult = [];
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'glob', { pattern: 'nothing/**' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('No files matched.');
  });

  it('calls findFiles with the pattern, node_modules exclusion, and a 200 cap', async () => {
    __state.findFilesResult = [];
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    await executeTool(ctx, 'glob', { pattern: 'src/**/*.ts' });
    expect(workspace.findFiles).toHaveBeenCalledWith('src/**/*.ts', '**/node_modules/**', 200);
  });
});
