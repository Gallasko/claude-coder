import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { executeTool, TOOL_DEFINITIONS } from '../tools';
import { makeCtx } from './helpers';
import { __state, __reset } from '../../test/mocks/vscode';

describe('executeTool', () => {
  it('returns an error outcome for an unknown tool name', async () => {
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'not_a_real_tool', {});
    expect(outcome).toEqual({ content: 'Unknown tool: not_a_real_tool', isError: true });
  });

  it('wraps a thrown executor error as an error outcome', async () => {
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'edit_file', { path: '/nonexistent/does/not/exist.ts', old_string: 'a', new_string: 'b' });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toMatch(/^Error: /);
  });

  describe('every defined tool runs successfully with a minimal valid input', () => {
    let dir: string;

    beforeEach(async () => {
      __reset();
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-executeTool-'));
      await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;', 'utf8');
      __state.workspaceFolders = [{ uri: { fsPath: dir } }];
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    const inputFor = (name: string) =>
      ({
        read_file: { path: 'a.ts' },
        write_file: { path: 'new.txt', content: 'hi' },
        edit_file: { path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' },
        multi_edit_file: { path: 'a.ts', edits: [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }] },
        glob: { pattern: '*.ts' },
        grep: { pattern: 'const' },
        run_command: { command: 'echo hi' },
        get_diagnostics: {},
        ask_question: {
          questions: [{ question: 'Which?', header: 'Which', options: [{ label: 'A', description: 'a' }], multiSelect: false }],
        },
      })[name];

    it.each(TOOL_DEFINITIONS)('$name', async (def) => {
      const ctx = makeCtx({ workspaceRoot: dir, askQuestion: vi.fn(async () => ({})) });
      const outcome = await executeTool(ctx, def.name, inputFor(def.name));
      expect(outcome.isError).toBe(false);
    });
  });
});
