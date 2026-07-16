import { describe, it, expect } from 'vitest';
import { makeController } from './helpers';

describe('Controller harness smoke test', () => {
  it('constructs a Controller against a fake context and UiSink', async () => {
    const { controller, posted } = await makeController();
    expect(controller).toBeTruthy();
    expect(posted.some((m) => m.type === 'sessionInfo')).toBe(true);
  });
});
