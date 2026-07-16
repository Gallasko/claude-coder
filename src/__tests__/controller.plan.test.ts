import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { makeController } from './helpers';
import { __reset, window } from '../test/mocks/vscode';

/** openPlanInEditor does real (fast) fs I/O before posting the 'permission' card, so a synchronous
 *  `posted.find(...)` right after calling requestPlanApproval races it — poll instead. */
async function waitForCard(posted: Record<string, unknown>[], predicate: (m: Record<string, unknown>) => boolean) {
  return vi.waitFor(
    () => {
      const card = posted.find(predicate);
      if (!card) {
        throw new Error('card not posted yet');
      }
      return card;
    },
    { timeout: 2000, interval: 10 }
  );
}

describe('Controller plan-approval flow', () => {
  beforeEach(() => {
    __reset();
    window.showTextDocument.mockReset();
    window.showTextDocument.mockImplementation(async () => undefined);
  });
  afterEach(() => {
    window.showTextDocument.mockReset();
    window.showTextDocument.mockImplementation(async () => undefined);
  });

  it('approve path: opens the plan, copies the temp file into <globalStorageUri>/plans/', async () => {
    const { controller, posted, context } = await makeController();
    const pending = (controller as any).requestPlanApproval('my plan text');
    const card = await waitForCard(posted, (m) => m.type === 'permission' && m.kind === 'plan');
    controller.handlePermissionResponse(card.id as number, 'yes');
    await expect(pending).resolves.toBe(true);
    expect(window.showTextDocument).toHaveBeenCalledTimes(1);
    const plansDir = path.join(context.globalStorageUri.fsPath, 'plans');
    const files = await fs.readdir(plansDir);
    expect(files).toHaveLength(1);
  });

  it('reject path: does not archive the temp file into plans/', async () => {
    const { controller, posted, context } = await makeController();
    const pending = (controller as any).requestPlanApproval('my plan text');
    const card = await waitForCard(posted, (m) => m.type === 'permission' && m.kind === 'plan');
    controller.handlePermissionResponse(card.id as number, 'no');
    await expect(pending).resolves.toBe(false);
    const plansDir = path.join(context.globalStorageUri.fsPath, 'plans');
    await expect(fs.readdir(plansDir)).rejects.toThrow();
  });

  it(
    'regression test: a transient failure that exhausts retries no longer leaks the permission resolver ' +
      '(this was the root cause of the "plan showing bugs out" report — requestPlanApproval used to throw ' +
      'before deleting the resolver it had just registered)',
    async () => {
      const { controller } = await makeController();
      window.showTextDocument.mockRejectedValue(new Error('stream closed'));
      await expect((controller as any).requestPlanApproval('my plan text')).rejects.toThrow('stream closed');
      expect((controller as any).permissionResolvers.size).toBe(0);
      expect(window.showTextDocument).toHaveBeenCalledTimes(3); // withTransientRetry's default 3 attempts
    },
    5000
  );

  it(
    'retries once transiently and then succeeds',
    async () => {
      const { controller, posted } = await makeController();
      window.showTextDocument.mockRejectedValueOnce(new Error('stream closed')).mockResolvedValueOnce(undefined);
      const pending = (controller as any).requestPlanApproval('my plan text');
      const card = await waitForCard(posted, (m) => m.type === 'permission' && m.kind === 'plan');
      controller.handlePermissionResponse(card.id as number, 'yes');
      await expect(pending).resolves.toBe(true);
      expect(window.showTextDocument).toHaveBeenCalledTimes(2);
    },
    5000
  );

  it('planIfNeeded short-circuits to true for trivial complexity without drafting a plan', async () => {
    const { controller, posted } = await makeController();
    const session = controller.sessions.current;
    const result = await (controller as any).planIfNeeded(undefined, session, 'trivial', 'do a trivial thing');
    expect(result).toBe(true);
    expect(posted.some((m) => m.type === 'permission' && m.kind === 'plan')).toBe(false);
  });

  it('planIfNeeded short-circuits to true when planningEnabled is off', async () => {
    const vscodeMock = await import('../test/mocks/vscode');
    vscodeMock.__state.config.planningEnabled = false;
    const { controller, posted } = await makeController();
    const session = controller.sessions.current;
    const result = await (controller as any).planIfNeeded(undefined, session, 'standard', 'do a standard thing');
    expect(result).toBe(true);
    expect(posted.some((m) => m.type === 'permission' && m.kind === 'plan')).toBe(false);
  });
});
