// story 4776 (AC3) — the session is renewed through ONE flight (lib/db/client.ts: `refreshSessionOnce` · `refreshSessionAfterChange`), never by calling `refreshAuthTokens` directly.
// The refresh token rotates on use: two rotations of the same token in flight are a race of which the loser lives only by the server's 180 s resolve window (a refresh with no window is a 401 and
// the BFF refresh route clears both cookies — backend/tests/test_4776_overlapping_refresh_realdb.py shows the loss). Before this story the onboarding had four direct callers
// (`finishToHome` · the refresh after the organization is made · `connect-step` · `advanced-connect`). This is the ratchet: any code reference to `refreshAuthTokens` outside client.ts is a failure.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..'); // apps/web/src
const OWNER = ['lib', 'db', 'client.ts'].join(sep);

/** drops block comments and `//` line comments (not the `//` of a URL: it must follow whitespace or start a line) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** files (relative to src) that mention `refreshAuthTokens` in CODE — a call, an import, an alias — other than the owner */
export function directRefreshReferences(files: Array<{ path: string; source: string }>): string[] {
  return files.filter((f) => f.path !== OWNER && /\brefreshAuthTokens\b/.test(stripComments(f.source))).map((f) => f.path);
}

function sourceFiles(dir: string, out: Array<{ path: string; source: string }> = []): Array<{ path: string; source: string }> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push({ path: relative(SRC, full), source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('[SID:4776] the session is renewed through one flight — no direct refreshAuthTokens outside lib/db/client.ts', () => {
  const tree = sourceFiles(SRC);

  it('the tree walked is the app (not an empty scan that would pass anything)', () => {
    expect(tree.length).toBeGreaterThan(500);
    expect(tree.some((f) => f.path === OWNER)).toBe(true);
    // the four onboarding callers renew through the flight, by name
    for (const p of ['app/onboarding/onboarding-form.tsx', 'app/onboarding/connect-step.tsx', 'app/onboarding/advanced-connect.tsx']) {
      expect(tree.find((f) => f.path.split('/').join(sep) === p.split('/').join(sep))?.source).toMatch(/refreshSessionAfterChange|refreshSessionOnce/);
    }
  });

  it('no file outside client.ts references refreshAuthTokens (a call · an import · an alias) — a new direct caller fails here', () => {
    expect(directRefreshReferences(tree)).toEqual([]); // reverted (a direct call in any of the four) → that file is listed
  });

  it('the scanner itself: it sees a call, an import and an alias; it ignores a comment and the owner file', () => {
    const f = (path: string, source: string) => ({ path, source });
    expect(directRefreshReferences([f('a.ts', "await refreshAuthTokens().catch(() => null);")])).toEqual(['a.ts']);
    expect(directRefreshReferences([f('b.tsx', "import { fetchWithAuth, refreshAuthTokens } from '@/lib/db/client';")])).toEqual(['b.tsx']);
    expect(directRefreshReferences([f('c.ts', 'const renew = refreshAuthTokens;')])).toEqual(['c.ts']);
    expect(directRefreshReferences([f('d.ts', "// the old refreshAuthTokens() call\n/* refreshAuthTokens() */ const x = 1;")])).toEqual([]);
    expect(directRefreshReferences([f(OWNER, 'export async function refreshAuthTokens() {}')])).toEqual([]);
    expect(directRefreshReferences([f('e.ts', "const u = 'https://x.test/a'; refreshAuthTokens();")])).toEqual(['e.ts']); // a URL's `//` is not a comment
  });
});
