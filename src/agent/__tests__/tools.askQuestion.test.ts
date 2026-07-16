import { describe, it, expect, vi } from 'vitest';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('ask_question', () => {
  it('returns the answers from ctx.askQuestion as JSON', async () => {
    const questions = [{ question: 'Which?', header: 'Which', options: [{ label: 'A', description: 'a' }], multiSelect: false }];
    const askQuestion = vi.fn(async () => ({ Which: 'A' }));
    const ctx = makeCtx({ workspaceRoot: '/workspace', askQuestion });
    const outcome = await executeTool(ctx, 'ask_question', { questions });
    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.content)).toEqual({ answers: { Which: 'A' } });
    expect(askQuestion).toHaveBeenCalledWith(questions);
  });

  it('throws when questions is missing', async () => {
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'ask_question', {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('non-empty array');
  });

  it('throws when questions is an empty array', async () => {
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'ask_question', { questions: [] });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('non-empty array');
  });

  it('throws when questions is not an array', async () => {
    const ctx = makeCtx({ workspaceRoot: '/workspace' });
    const outcome = await executeTool(ctx, 'ask_question', { questions: 'not-an-array' });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('non-empty array');
  });
});
