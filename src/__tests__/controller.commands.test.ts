import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeController } from './helpers';
import * as sdkBackend from '../agent/sdkBackend';

vi.mock('../agent/sdkBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/sdkBackend')>();
  return { ...actual, fetchSubscriptionRateLimit: vi.fn() };
});

describe('showSubscriptionUsage (/plan-usage)', () => {
  beforeEach(() => {
    vi.mocked(sdkBackend.fetchSubscriptionRateLimit).mockReset();
  });

  it('posts a usage summary notice when windows are present', async () => {
    vi.mocked(sdkBackend.fetchSubscriptionRateLimit).mockResolvedValue({
      windows: [{ label: '5h', utilization: 42, resetsAt: undefined }],
    });
    const { controller, posted } = await makeController();
    await controller.showSubscriptionUsage();
    const notice = posted.find((m) => m.type === 'notice' && typeof m.text === 'string' && (m.text as string).includes('plan usage'));
    expect(notice?.text).toContain('5h: 42% used');
  });

  it('posts a "no data" notice for an empty windows array', async () => {
    vi.mocked(sdkBackend.fetchSubscriptionRateLimit).mockResolvedValue({ windows: [] });
    const { controller, posted } = await makeController();
    await controller.showSubscriptionUsage();
    expect(posted.some((m) => m.type === 'notice' && (m.text as string).includes('No plan rate-limit data'))).toBe(true);
  });

  it('posts a setupNeeded card when the fetch reports a setup gap (the "/plan-usage bugs out" case)', async () => {
    const err: any = new Error('Claude Code is not logged in.');
    err.setupNeeded = true;
    vi.mocked(sdkBackend.fetchSubscriptionRateLimit).mockRejectedValue(err);
    const { controller, posted } = await makeController();
    await controller.showSubscriptionUsage();
    expect(posted.some((m) => m.type === 'setupNeeded')).toBe(true);
  });

  it('posts a plain error notice for a non-setup failure', async () => {
    vi.mocked(sdkBackend.fetchSubscriptionRateLimit).mockRejectedValue(new Error('boom'));
    const { controller, posted } = await makeController();
    await controller.showSubscriptionUsage();
    const notice = posted.find((m) => m.type === 'notice' && (m.text as string).includes("Couldn't fetch subscription usage"));
    expect(notice).toBeTruthy();
  });
});

describe('handleDeferredCommand (/deferred)', () => {
  it('reports no pending tasks when the store is empty', async () => {
    const { controller, posted } = await makeController();
    await controller.handleDeferredCommand('');
    expect(posted.some((m) => m.type === 'notice' && (m.text as string).includes('No deferred tasks'))).toBe(true);
  });

  it('cancels a pending task by id', async () => {
    const { controller, posted } = await makeController();
    const store = await (controller as any).ensureDeferredTasks();
    const task = store.add('resume me later', new Date(Date.now() + 3_600_000).toISOString());
    await controller.handleDeferredCommand(`cancel ${task.id}`);
    expect(posted.some((m) => m.type === 'notice' && (m.text as string).includes(`Deferred task #${task.id} cancelled`))).toBe(true);
  });

  it('falls back to listing pending tasks when "cancel" is followed by a non-numeric id', async () => {
    const { controller, posted } = await makeController();
    await controller.handleDeferredCommand('cancel abc');
    expect(posted.some((m) => m.type === 'notice' && (m.text as string).includes('No deferred tasks'))).toBe(true);
  });
});

describe('resetPermissions', () => {
  it('clears alwaysAllowed for the current session', async () => {
    const { controller } = await makeController();
    controller.sessions.current.alwaysAllowed.add('workspace-edits');
    await controller.resetPermissions();
    expect(controller.sessions.current.alwaysAllowed.size).toBe(0);
  });
});
