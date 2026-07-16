import { describe, it, expect } from 'vitest';
import { makeController } from './helpers';

describe('Controller.cancel()', () => {
  it('settles both a pending permission and a pending question, clearing both maps', async () => {
    const { controller } = await makeController();
    const permissionPending = (controller as any).requestPermission({
      kind: 'edit' as const,
      key: 'workspace-edits',
      title: 't',
      detail: 'd',
    });
    const questionPending = (controller as any).requestQuestion([
      { question: 'Q?', header: 'Q', options: [{ label: 'A', description: 'a' }], multiSelect: false },
    ]);
    controller.cancel();
    await expect(permissionPending).resolves.toBe(false);
    await expect(questionPending).resolves.toEqual({});
    expect((controller as any).permissionResolvers.size).toBe(0);
    expect((controller as any).questionResolvers.size).toBe(0);
  });

  it('is a safe no-op when nothing is pending', async () => {
    const { controller } = await makeController();
    expect(() => controller.cancel()).not.toThrow();
  });
});
