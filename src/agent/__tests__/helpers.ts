import { vi } from 'vitest';
import type { ToolContext } from '../tools';

export function fakeMemory() {
  return {
    whenSaved: vi.fn(async () => undefined),
    freshSummary: vi.fn(() => undefined as string | undefined),
    bumpReadCount: vi.fn(() => 1),
    getFileRecord: vi.fn(() => undefined),
    noteRead: vi.fn(() => 1),
    saveSummary: vi.fn(),
    noteChange: vi.fn(),
  } as any;
}

export function makeCtx(overrides: Partial<ToolContext> & { workspaceRoot: string }): ToolContext {
  return {
    requestPermission: vi.fn(async () => true),
    requestEditApproval: vi.fn(async () => true),
    memory: fakeMemory(),
    taskId: 't1',
    taskSummary: 'test task',
    readCache: new Map(),
    askQuestion: vi.fn(async () => ({})),
    ...overrides,
  };
}
