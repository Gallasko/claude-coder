import { describe, it, expect, vi } from 'vitest';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('search_memory', () => {
  it("returns 'none' when ctx.searchMemory is absent", async () => {
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'search_memory', { task_description: 'add a widget' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('none');
  });

  it('passes the task description through to ctx.searchMemory and returns its result', async () => {
    const searchMemory = vi.fn(async () => '- Old task: did X (files: a.ts, b.ts)');
    const ctx = makeCtx({ workspaceRoot: '/workspace', searchMemory });
    const outcome = await executeTool(ctx, 'search_memory', { task_description: 'add a widget' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('- Old task: did X (files: a.ts, b.ts)');
    expect(searchMemory).toHaveBeenCalledWith('add a widget');
  });

  it('falls back to ctx.taskSummary when task_description is missing', async () => {
    const searchMemory = vi.fn(async () => 'none');
    const ctx = makeCtx({ workspaceRoot: '/workspace', taskSummary: 'the current task', searchMemory });
    await executeTool(ctx, 'search_memory', {});
    expect(searchMemory).toHaveBeenCalledWith('the current task');
  });
});
