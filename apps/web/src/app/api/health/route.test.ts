// story #4513 — /api/health says what the instance runs: commit · revision · build time, «unknown» when absent or off shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState: { buildTime: string | null } = { buildTime: null };
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    if (path === '/app/.build_time' && fsState.buildTime !== null) return fsState.buildTime;
    throw new Error('ENOENT');
  },
}));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const saved = { ...process.env };

describe('[SID:4513] /api/health build info', () => {
  beforeEach(() => { fsState.buildTime = null; });
  afterEach(() => { process.env = { ...saved }; });

  it('reports the commit, the revision and the build time', async () => {
    const { GET } = await import('./route');
    fsState.buildTime = '2026-10-03T01:55:00Z\n';
    Object.assign(process.env, { APP_COMMIT_SHA: SHA, K_REVISION: 'sprintable-frontend-dev-00301-xyz' });
    const body = await (await GET()).json();
    expect([body.commit_sha, body.revision, body.build_time]).toEqual([SHA, 'sprintable-frontend-dev-00301-xyz', '2026-10-03T01:55:00Z']);
    expect(body.status).toBe('ok');
  });

  it('absent or off-shape values are unknown, never echoed', async () => {
    const { GET } = await import('./route');
    Object.assign(process.env, { APP_COMMIT_SHA: 'postgresql://u:p@10.0.0.1/db', K_REVISION: 'Has Spaces' });
    const body = await (await GET()).json();
    expect([body.commit_sha, body.revision, body.build_time]).toEqual(['unknown', 'unknown', 'unknown']);
  });
});
