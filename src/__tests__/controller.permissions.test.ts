import { describe, it, expect, beforeEach } from 'vitest';
import { makeController } from './helpers';
import { __reset } from '../test/mocks/vscode';

describe('Controller permission flow', () => {
  beforeEach(() => {
    __reset();
  });

  it('resolves true when the user answers yes', async () => {
    const { controller, posted } = await makeController();
    const req = { kind: 'edit' as const, key: 'workspace-edits', title: 'Edit a.ts', detail: '...' };
    const pending = (controller as any).requestPermission(req);
    const card = posted.find((m) => m.type === 'permission');
    expect(card).toMatchObject({ title: 'Edit a.ts', detail: '...' });
    controller.handlePermissionResponse(card!.id as number, 'yes');
    await expect(pending).resolves.toBe(true);
    expect(posted).toContainEqual({ type: 'permissionResolved', id: card!.id, choice: 'yes' });
  });

  it('"always" grants future requests with the same key without another card', async () => {
    const { controller, posted } = await makeController();
    const req = { kind: 'edit' as const, key: 'workspace-edits', title: 'Edit a.ts', detail: '...' };
    const first = (controller as any).requestPermission(req);
    const firstCard = posted.find((m) => m.type === 'permission')!;
    controller.handlePermissionResponse(firstCard.id as number, 'always');
    expect(await first).toBe(true);

    const second = await (controller as any).requestPermission(req);
    expect(second).toBe(true);
    expect(posted.filter((m) => m.type === 'permission')).toHaveLength(1);
  });

  it('auto-approves a command when autoApproveCommands is enabled, without posting a card', async () => {
    const { controller, posted } = await makeController();
    const vscodeMock = await import('../test/mocks/vscode');
    vscodeMock.__state.config.autoApproveCommands = true;
    const req = { kind: 'command' as const, key: 'command:npm', title: 'Run command', detail: 'npm test' };
    const result = await (controller as any).requestPermission(req);
    expect(result).toBe(true);
    expect(posted.some((m) => m.type === 'permission')).toBe(false);
  });

  it('handlePermissionResponse is a no-op for an unknown or already-resolved id', () => {
    const promise = makeController();
    return promise.then(({ controller }) => {
      expect(() => controller.handlePermissionResponse(999999, 'yes')).not.toThrow();
    });
  });

  it('cancel() resolves a pending permission to false and clears the resolver', async () => {
    const { controller } = await makeController();
    const req = { kind: 'edit' as const, key: 'workspace-edits', title: 'Edit a.ts', detail: '...' };
    const pending = (controller as any).requestPermission(req);
    controller.cancel();
    await expect(pending).resolves.toBe(false);
    expect((controller as any).permissionResolvers.size).toBe(0);
  });
});
