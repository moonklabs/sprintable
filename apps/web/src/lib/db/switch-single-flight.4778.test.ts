// story 4778 (AC3) — the page switches organization / project ONLY through `switchOrg` · `switchProject` of lib/db/client.ts (the page's one flight with the refresh rotation).
// A switch revokes the session's refresh token on the server and answers with a new pair; a rotation of the same token that overlaps it is refused (401 → the BFF refresh route clears BOTH cookies).
// This is the ratchet: no code file other than client.ts names the BFF routes `/api/switch-org` · `/api/switch-project` in a string, so a new caller cannot POST them on its own (a plain fetch · fetchWithAuth ·
// a template built around the address). The test files and the route handlers' own directories do not count (a handler's file path is not a string in code).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..'); // apps/web/src
const OWNER = ['lib', 'db', 'client.ts'].join(sep);

/** drops block comments and `//` line comments (not the `//` of a URL: it must follow whitespace or start a line) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** a string literal (', " or `) that contains one of the two routes' client addresses — any position: `'/api/switch-org'`, `` `${base}/api/switch-project?x` ``, … */
const NAMES_A_SWITCH_ROUTE = /(['"`])(?:(?!\1)[^\n])*\/api\/switch-(?:org|project)(?:(?!\1)[^\n])*\1/;

export function switchRouteNamers(files: Array<{ path: string; source: string }>): string[] {
  return files.filter((f) => f.path !== OWNER && NAMES_A_SWITCH_ROUTE.test(stripComments(f.source))).map((f) => f.path);
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

describe('[SID:4778] the page switches only through lib/db/client.ts — no other file names /api/switch-org · /api/switch-project', () => {
  const tree = sourceFiles(SRC);

  it('the tree walked is the app (not an empty scan that would pass anything) and the owner names both routes', () => {
    expect(tree.length).toBeGreaterThan(500);
    const owner = tree.find((f) => f.path === OWNER);
    expect(owner?.source).toContain("'/api/switch-org'");
    expect(owner?.source).toContain("'/api/switch-project'");
    // the callers go through the named functions
    for (const p of ['app/dashboard/dashboard-shell.tsx', 'hooks/use-unified-switcher.ts', 'components/nav/org-hint-banner.tsx', 'components/desktop/desktop-setup.tsx']) {
      expect(tree.find((f) => f.path.split('/').join(sep) === p.split('/').join(sep))?.source).toMatch(/switchOrg/);
    }
  });

  it('no file outside client.ts names a switch route in a string — a new direct caller fails here', () => {
    expect(switchRouteNamers(tree)).toEqual([]); // reverted (a plain fetch of the route in any caller) → that file is listed
  });

  it('the scanner itself: it sees a plain fetch, fetchWithAuth, a template, a path concatenation; it ignores a comment, the owner file and another address', () => {
    const f = (path: string, source: string) => ({ path, source });
    expect(switchRouteNamers([f('a.ts', "await fetch('/api/switch-org', { method: 'POST' });")])).toEqual(['a.ts']);
    expect(switchRouteNamers([f('b.tsx', "await fetchWithAuth('/api/switch-project', {});")])).toEqual(['b.tsx']);
    expect(switchRouteNamers([f('c.ts', 'const r = await fetch(`/api/switch-org`);')])).toEqual(['c.ts']);
    expect(switchRouteNamers([f('d.ts', 'const r = await fetch(`${base}/api/switch-project?x=1`);')])).toEqual(['d.ts']);
    expect(switchRouteNamers([f('e.ts', "const u = '/api/' + 'switch-org';")])).toEqual([]); // known blind spot of a literal scan: a concatenation split across two strings (a reviewer's job, noted in the PR)
    expect(switchRouteNamers([f('g.ts', "// POST /api/switch-org (the route)\n/* '/api/switch-project' */ const x = 1;")])).toEqual([]);
    expect(switchRouteNamers([f(OWNER, "const p = '/api/switch-org';")])).toEqual([]);
    expect(switchRouteNamers([f('h.ts', "const u = '/api/switch-organization-list';")])).toEqual(['h.ts']); // a longer address that CONTAINS the name is still flagged (conservative)
    expect(switchRouteNamers([f('i.ts', "const u = '/api/v2/auth/switch-org';")])).toEqual([]); // the backend's address (the BFF routes call it) is another string
  });
});
