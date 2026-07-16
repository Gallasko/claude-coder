import { describe, it, expect, vi } from 'vitest';
import { executeTool } from '../tools';
import { makeCtx } from './helpers';

describe('run_command', () => {
  it('returns DENIED without running the command when permission is refused', async () => {
    const ctx = makeCtx({ workspaceRoot: '/tmp', requestPermission: vi.fn(async () => false) });
    const outcome = await executeTool(ctx, 'run_command', { command: 'echo should-not-run' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('denied permission');
  });

  it('runs an approved command and reports exit code 0 with stdout', async () => {
    const ctx = makeCtx({ workspaceRoot: '/tmp' });
    const outcome = await executeTool(ctx, 'run_command', { command: 'echo hello' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('exit code: 0');
    expect(outcome.content).toContain('stdout:\nhello');
  });

  it('reports a non-zero exit code', async () => {
    const ctx = makeCtx({ workspaceRoot: '/tmp' });
    const outcome = await executeTool(ctx, 'run_command', { command: 'exit 3' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('exit code: 3');
  });

  it('captures stderr', async () => {
    const ctx = makeCtx({ workspaceRoot: '/tmp' });
    const outcome = await executeTool(ctx, 'run_command', { command: 'echo oops 1>&2' });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain('stderr:\noops');
  });

  it('requests permission with the first word of the command as the key', async () => {
    const requestPermission = vi.fn(async () => true);
    const ctx = makeCtx({ workspaceRoot: '/tmp', requestPermission });
    // Deliberately a nonexistent binary — the permission key is derived before execution,
    // and a fast, network-free failure keeps this test quick and deterministic.
    await executeTool(ctx, 'run_command', { command: 'npm-nonexistent-binary install foo' });
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'command', key: 'command:npm-nonexistent-binary' })
    );
  });
});
