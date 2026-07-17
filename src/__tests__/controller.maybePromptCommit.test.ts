import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeController } from './helpers';

const execFileMock = vi.fn();

/** Lets the pending execFileAsync promise chains inside maybePromptCommit settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: (...args: any[]) => execFileMock(...args) };
});

/** execFile(cmd, args, options, cb) — resolve cb with the stdout configured for this call. */
function mockGit(responses: Record<string, string>) {
  execFileMock.mockImplementation((_cmd: string, gitArgs: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (err: unknown, res: { stdout: string; stderr: string }) => void;
    const key = gitArgs[0];
    if (key in responses) {
      cb(null, { stdout: responses[key], stderr: '' });
    } else {
      cb(new Error(`unexpected git ${key}`), { stdout: '', stderr: '' });
    }
  });
}

describe('Controller.maybePromptCommit', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('asks the user and commits when they choose "Commit"', async () => {
    mockGit({ 'rev-parse': '', status: ' M file.ts\n', add: '', commit: '' });
    const { controller, posted } = await makeController();
    const commitSpy = vi.spyOn(controller, 'commitChanges').mockResolvedValue();

    const pending = (controller as any).maybePromptCommit();
    await flushMicrotasks();
    const card = posted.find((m) => m.type === 'askQuestion')!;
    expect(card).toBeTruthy();
    controller.handleAskQuestionResponse(card.id as number, { 'Commit these changes?': 'Commit' });
    await pending;

    expect(commitSpy).toHaveBeenCalledWith('', 'claude');
  });

  it('does not commit when the user chooses "Not now"', async () => {
    mockGit({ 'rev-parse': '', status: ' M file.ts\n' });
    const { controller, posted } = await makeController();
    const commitSpy = vi.spyOn(controller, 'commitChanges').mockResolvedValue();

    const pending = (controller as any).maybePromptCommit();
    await flushMicrotasks();
    const card = posted.find((m) => m.type === 'askQuestion')!;
    controller.handleAskQuestionResponse(card.id as number, { 'Commit these changes?': 'Not now' });
    await pending;

    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('skips the prompt on a clean working tree', async () => {
    mockGit({ 'rev-parse': '', status: '' });
    const { controller, posted } = await makeController();

    await (controller as any).maybePromptCommit();

    expect(posted.some((m) => m.type === 'askQuestion')).toBe(false);
  });

  it('skips the prompt when not a git repository', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: unknown) => void;
      cb(new Error('not a git repo'));
    });
    const { controller, posted } = await makeController();

    await (controller as any).maybePromptCommit();

    expect(posted.some((m) => m.type === 'askQuestion')).toBe(false);
  });
});
