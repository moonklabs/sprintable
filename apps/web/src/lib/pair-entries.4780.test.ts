// story 4780 (ratchet) — the phone's pairing screen is entered only through `usePairHref` (which hands the page over for [Close]); a new link that writes `/desktop/pair` itself would bring the person
// back to the Mac screen again. No code file outside lib/pair-return.ts · hooks/use-pair-href.ts names the address in a string (comments ignored).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..'); // apps/web/src
const OWNERS = new Set([['lib', 'pair-return.ts'].join(sep), ['hooks', 'use-pair-href.ts'].join(sep)]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}
const NAMES_THE_PAIR_SCREEN = /(['"`])(?:(?!\1)[^\n])*\/desktop\/pair(?:(?!\1)[^\n])*\1/;

export function pairScreenNamers(files: Array<{ path: string; source: string }>): string[] {
  return files.filter((f) => !OWNERS.has(f.path) && NAMES_THE_PAIR_SCREEN.test(stripComments(f.source))).map((f) => f.path);
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

describe('[SID:4780] the pairing screen is entered only through usePairHref', () => {
  const tree = sourceFiles(SRC);
  it('the tree walked is the app, and the five entries use the hook', () => {
    expect(tree.length).toBeGreaterThan(500);
    for (const p of ['components/org-briefing/today-pair-card.tsx', 'components/chat/agent-session-strip.tsx', 'components/inbox/agent-permission-requests.tsx', 'components/desktop/phone-first-screen.tsx', 'components/desktop/phone-pairing.tsx']) {
      expect(tree.find((f) => f.path.split('/').join(sep) === p.split('/').join(sep))?.source).toContain('usePairHref');
    }
  });
  it('no other file writes the pairing screen\'s address in a string — a new entry that does fails here', () => {
    expect(pairScreenNamers(tree)).toEqual([]); // reverted (an entry back to flat('/desktop/pair')) → that file is listed
  });
  it('the scanner itself: it sees a link, a template and a flat() argument; it ignores a comment and the owners', () => {
    const f = (path: string, source: string) => ({ path, source });
    expect(pairScreenNamers([f('a.tsx', "<a href={flat('/desktop/pair')}>x</a>")])).toEqual(['a.tsx']);
    expect(pairScreenNamers([f('b.tsx', 'const h = `/desktop/pair?x=1`;')])).toEqual(['b.tsx']);
    expect(pairScreenNamers([f('c.ts', '// the /desktop/pair screen\nconst x = 1;')])).toEqual([]);
    expect(pairScreenNamers([f(['lib', 'pair-return.ts'].join(sep), "return '/desktop/pair';")])).toEqual([]);
  });
});
