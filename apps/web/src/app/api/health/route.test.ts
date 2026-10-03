// story #4513 — /api/health says what the instance runs: commit · revision · build time, «unknown» when absent or off shape.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const saved = { ...process.env };

describe('[SID:4513] /api/health build info', () => {
  afterEach(() => { process.env = { ...saved }; });

  it('reports the commit, the revision and the build time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-'));
    writeFileSync(join(dir, '.build_time'), '2026-10-03T01:55:00Z\n');
    Object.assign(process.env, { APP_COMMIT_SHA: SHA, K_REVISION: 'sprintable-frontend-dev-00301-xyz', APP_BUILD_TIME_FILE: join(dir, '.build_time') });
    const body = await (await GET()).json();
    expect([body.commit_sha, body.revision, body.build_time]).toEqual([SHA, 'sprintable-frontend-dev-00301-xyz', '2026-10-03T01:55:00Z']);
    expect(body.status).toBe('ok');
  });

  it('absent or off-shape values are unknown, never echoed', async () => {
    Object.assign(process.env, { APP_COMMIT_SHA: 'postgresql://u:p@10.0.0.1/db', K_REVISION: 'Has Spaces', APP_BUILD_TIME_FILE: '/nonexistent/.build_time' });
    const body = await (await GET()).json();
    expect([body.commit_sha, body.revision, body.build_time]).toEqual(['unknown', 'unknown', 'unknown']);
  });
});
