// story 4778 — desktop-setup's three organization switches (entering the own organization · after an invite is accepted · after the member card's own make) used `fetchWithAuth` before the switch joined the page's
// one flight; `fetchWithAuth` renewed the session on a 401 and asked once more. `switchOrg(…, { withAuth: true })` is that same behavior: a call that loses `withAuth` hands the 401 back as a failure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'desktop-setup.tsx'), 'utf8');

describe('[SID:4778] desktop-setup switches the organization with the renewal (withAuth)', () => {
  const calls = [...source.matchAll(/\bswitchOrg\(([^;]*?)\);/g)].map((m) => m[1]!);
  it('there are three switchOrg calls, and every one of them asks for withAuth', () => {
    expect(calls).toHaveLength(3); // a fourth caller added without thinking about the 401 fails here, so does a removed one
    for (const c of calls) expect(c).toMatch(/\{\s*withAuth:\s*true\s*\}/); // reverted (the option dropped in any call) → that call is listed
  });
});
