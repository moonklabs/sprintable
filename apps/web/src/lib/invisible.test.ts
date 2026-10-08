// story 4637 (PO): the web's copy of the invisible-character table (lib/invisible.ts) is pinned by its SHA-256. A one-character change to
// the copy turns this RED. When the mobile table changes: change it there first (mobile desktop-protocol/invisible.ts), copy it here,
// then set PINNED to the new hash (`node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('invisible.ts')).digest('hex'))"`
// run in this folder). The mobile side is compared byte for byte by a daily run (디디 몫).
// Limit: a drift between the two repos is seen by this check at the next web CI run, not in the mobile repo's own run — up to a day late.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PINNED = 'e864f86dcafda3157dfd61ee8bbc29fff8445514d610da3831cd0c160f2ee892';

describe('[4637] the web copy of the invisible-character table is the pinned one', () => {
  it('lib/invisible.ts hashes to the pinned SHA-256 — a one-character change turns this RED', () => {
    const file = fileURLToPath(new URL('./invisible.ts', import.meta.url));
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(PINNED);
  });
});
