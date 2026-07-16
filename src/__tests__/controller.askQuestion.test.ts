import { describe, it, expect } from 'vitest';
import { makeController } from './helpers';

const QUESTIONS = [
  { question: 'Which?', header: 'Which', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false },
];

describe('Controller ask-question flow', () => {
  it('resolves with the answers posted back via handleAskQuestionResponse', async () => {
    const { controller, posted } = await makeController();
    const pending = (controller as any).requestQuestion(QUESTIONS);
    const card = posted.find((m) => m.type === 'askQuestion')!;
    expect(card.questions).toEqual(QUESTIONS);
    controller.handleAskQuestionResponse(card.id as number, { Which: 'A' });
    await expect(pending).resolves.toEqual({ Which: 'A' });
    expect(posted).toContainEqual({ type: 'askQuestionResolved', id: card.id, answers: { Which: 'A' } });
  });

  it('handleAskQuestionResponse is a no-op for an unknown id', async () => {
    const { controller } = await makeController();
    expect(() => controller.handleAskQuestionResponse(999999, { x: 'y' })).not.toThrow();
  });

  it('cancel() resolves a pending question to {} and clears the resolver — a late response is then a silent no-op', async () => {
    const { controller, posted } = await makeController();
    const pending = (controller as any).requestQuestion(QUESTIONS);
    const card = posted.find((m) => m.type === 'askQuestion')!;
    controller.cancel();
    await expect(pending).resolves.toEqual({});
    expect((controller as any).questionResolvers.size).toBe(0);

    // Simulates the webview's in-flight click arriving after cancel() already
    // auto-resolved the card — this is the "I answered but nothing happened"
    // symptom: the late response is silently dropped, no error, no new post.
    const postsBefore = posted.length;
    expect(() => controller.handleAskQuestionResponse(card.id as number, { Which: 'B' })).not.toThrow();
    expect(posted).toHaveLength(postsBefore);
  });

  it('buildToolContext().askQuestion delegates through the same requestQuestion plumbing', async () => {
    const { controller, posted } = await makeController();
    const session = controller.sessions.current;
    const memory = { noteChange: () => undefined } as any;
    const ctx = (controller as any).buildToolContext(session, memory, undefined);
    const pending = ctx.askQuestion(QUESTIONS);
    const card = posted.find((m) => m.type === 'askQuestion')!;
    controller.handleAskQuestionResponse(card.id as number, { Which: 'A' });
    await expect(pending).resolves.toEqual({ Which: 'A' });
  });
});
