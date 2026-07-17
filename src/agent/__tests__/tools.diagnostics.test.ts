import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';
import { __state, __reset, Uri, DiagnosticSeverity, languages } from '../../test/mocks/vscode';

const ROOT = path.join(os.tmpdir(), 'cc-diagnostics-test', 'workspace');

describe('get_diagnostics', () => {
  beforeEach(() => {
    __reset();
    __state.workspaceFolders = [{ uri: { fsPath: ROOT } }];
  });

  it('reports no errors or warnings when there are none', async () => {
    const ctx = makeCtx({ workspaceRoot: ROOT });
    const outcome = await executeTool(ctx, 'get_diagnostics', {});
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('No errors or warnings.');
  });

  it('formats mixed-severity diagnostics, filtering out Info/Hint, 1-based lines', async () => {
    const uri = Uri.file(path.join(ROOT, 'a.ts'));
    __state.diagnostics.set(uri.toString(), [
      { range: { start: { line: 4 } }, severity: DiagnosticSeverity.Error, message: 'bad thing' },
      { range: { start: { line: 9 } }, severity: DiagnosticSeverity.Warning, message: 'meh' },
      { range: { start: { line: 1 } }, severity: DiagnosticSeverity.Information, message: 'fyi' },
    ]);
    const ctx = makeCtx({ workspaceRoot: ROOT });
    const outcome = await executeTool(ctx, 'get_diagnostics', { path: 'a.ts' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('a.ts:5 [Error] bad thing');
    expect(outcome.content).toContain('a.ts:10 [Warning] meh');
    expect(outcome.content).not.toContain('fyi');
  });

  it('calls the 1-arg getDiagnostics(uri) form when a path is given', async () => {
    const ctx = makeCtx({ workspaceRoot: ROOT });
    await executeTool(ctx, 'get_diagnostics', { path: 'a.ts' });
    expect(languages.getDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ fsPath: path.join(ROOT, 'a.ts') }));
  });

  it('throws for a path outside the workspace, without calling getDiagnostics', async () => {
    const ctx = makeCtx({ workspaceRoot: ROOT });
    const outsidePath = path.join(os.tmpdir(), 'cc-diagnostics-test', 'other', 'passwd');
    const outcome = await executeTool(ctx, 'get_diagnostics', { path: outsidePath });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('only available for workspace files');
  });
});
