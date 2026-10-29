// story 4811 (OPEN-ZERO ⑧, PR-S) — the four sprint analysis BFF routes are gone (the backend paths they proxied no longer exist), and the BFF routes the sprint screen
// still needs are there. Read from the filesystem, so putting a deleted route back turns this red even if nothing imports it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SPRINTS_API = path.dirname(fileURLToPath(import.meta.url));

const WITHDRAWN = ['burndown', 'checkin', 'summary', 'velocity'];
const KEPT_FILES = [
  'route.ts', // GET list · POST create
  '[id]/route.ts', // GET · PATCH · DELETE
  '[id]/activate/route.ts',
  '[id]/close/route.ts',
  '[id]/kickoff/route.ts',
  '[id]/hypotheses/route.ts', // goes with the hypothesis lane (4811 PR-H), still here
];

describe('story 4811 — sprint analysis BFF routes', () => {
  it.each(WITHDRAWN)('api/sprints/[id]/%s has no route file', (segment) => {
    expect(existsSync(path.join(SPRINTS_API, '[id]', segment, 'route.ts'))).toBe(false);
    expect(existsSync(path.join(SPRINTS_API, '[id]', segment))).toBe(false);
  });

  it.each(KEPT_FILES)('%s — the route the sprint screen uses is still there', (rel) => {
    expect(existsSync(path.join(SPRINTS_API, rel))).toBe(true);
  });
});
