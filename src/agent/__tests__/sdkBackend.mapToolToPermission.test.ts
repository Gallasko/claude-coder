import { describe, it, expect } from 'vitest';
import { mapToolToPermission } from '../sdkBackend';

const ROOT = '/workspace';

describe('mapToolToPermission', () => {
  it('maps Bash to a command permission card keyed by the first word', () => {
    const req = mapToolToPermission('Bash', { command: 'npm test -- --watch' }, ROOT);
    expect(req).toEqual({ kind: 'command', key: 'command:npm', title: 'Run command', detail: 'npm test -- --watch' });
  });

  it('maps NotebookEdit inside the workspace to a workspace-edits permission card', () => {
    const req = mapToolToPermission('NotebookEdit', { file_path: `${ROOT}/notebooks/a.ipynb` }, ROOT);
    expect(req?.kind).toBe('edit');
    expect(req?.key).toBe('workspace-edits');
    expect(req?.title).toContain('notebooks/a.ipynb');
  });

  it('maps NotebookEdit outside the workspace to an outside-write permission card', () => {
    const req = mapToolToPermission('NotebookEdit', { file_path: '/etc/other/a.ipynb' }, ROOT);
    expect(req?.kind).toBe('outside-write');
    expect(req?.key).toBe('write:/etc/other');
  });

  it('falls back to an "(unknown path)" title when NotebookEdit has no file_path', () => {
    const req = mapToolToPermission('NotebookEdit', {}, ROOT);
    expect(req?.kind).toBe('edit');
    expect(req?.title).toContain('(unknown path)');
  });

  it.each(['WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Read', 'Grep', 'Glob', 'search_memory'])(
    'allows %s silently (returns undefined)',
    (toolName) => {
      expect(mapToolToPermission(toolName, {}, ROOT)).toBeUndefined();
    }
  );
});
