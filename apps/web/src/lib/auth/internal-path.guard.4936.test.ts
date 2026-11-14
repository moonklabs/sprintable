// story 4936 AC2 (static guard) — no file of `apps/web/src` writes its own «is this an address of this app» test. The one is lib/auth/internal-path.ts; `startsWith('//')` is how every hand-written copy of it
// looked (and each copy was the old, weak one: a TAB between the slashes passed). The three slash-COMMAND files are not addresses (a chat line that starts with `//` is a literal `/…`), so they are listed.
// Reverting any consumer to its own guard turns the first two tests red; a NEW file that reads a `next` · `return` · `redirect` value and neither imports the function nor is a listed exact-compare turns the third red.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const THE_FUNCTION = 'lib/auth/internal-path.ts';
// chat slash-commands: «//text» = a message that begins with a literal slash — not a navigation
const NOT_ADDRESSES = new Set(['components/chat/chat-bubble.tsx', 'components/chat/chat-input.tsx', 'lib/command-classifier.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\.|\.test-helper\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The code of a source file without its comments — and with every string kept AS WRITTEN (`startsWith('//')` must survive; a `//` inside a string is not a comment). A string ends at its quote, a single- or double-quoted one also at the line end. */
export function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === "'" || c === '"' || c === '`') {
      out += c; i += 1;
      while (i < n) {
        const ch = src[i]!;
        out += ch; i += 1;
        if (ch === '\\') { out += src[i] ?? ''; i += 1; continue; }
        if (ch === c) break;
        if (c !== '`' && ch === '\n') break;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

const SLASH_SLASH = /startsWith\(\s*['"`]\/\/['"`]\s*\)/;
// `startsWith('/')` and `includes('\\')` near each other (either order, a screenful apart at most) = the other shape of the same hand-written copy
const SLASH_AND_BACKSLASH = /startsWith\(\s*['"`]\/['"`]\s*\)[\s\S]{0,300}includes\(\s*['"`]\\\\['"`]\s*\)|includes\(\s*['"`]\\\\['"`]\s*\)[\s\S]{0,300}startsWith\(\s*['"`]\/['"`]\s*\)/;

describe('the comment/string reader of this guard', () => {
  it('keeps a `//` that sits inside a string, drops real comments', () => {
    expect(codeOnly("const marker = ' //'; if (next.startsWith('//')) go(); // gone\n/* gone too */ x();")).toMatch(SLASH_SLASH);
    expect(codeOnly("// next.startsWith('//')\n/* next.startsWith('//') */ ok();")).not.toMatch(SLASH_SLASH);
    expect(codeOnly('if (next\n  .startsWith(\n    "//"\n  )) go();')).toMatch(SLASH_SLASH);
  });
});

describe('one internal-path guard — story 4936', () => {
  it('no file but lib/auth/internal-path.ts tests `startsWith(\'//\')` (a hand-written address guard) — the chat slash-command files excepted', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (rel === THE_FUNCTION || NOT_ADDRESSES.has(rel)) continue;
      if (SLASH_SLASH.test(codeOnly(readFileSync(f, 'utf8')))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('no file tests `startsWith(\'/\')` together with `includes(\'\\\\\')` as its own guard either (the other shape of the same copy)', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (rel === THE_FUNCTION) continue;
      if (SLASH_AND_BACKSLASH.test(codeOnly(readFileSync(f, 'utf8')))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('every file that reads a `next` · `return` · `redirect` value from an address or body imports the one function (directly, or through safeNextPath · safeReturnPath) — or is a listed exact-compare', () => {
    const READS_A_TARGET = /\.get\(\s*['"`](?:next|return|returnTo|return_to|returnUrl|redirect|redirect_to|redirectTo|redirect_uri|redirect_path|callbackUrl|callback_url|continue|dest)['"`]\s*\)|\bredirect_path\b|\b(?:searchParams|params)\??\.(?:next|return|redirect|redirectTo|callbackUrl)\b/;
    // they read the value but only compare it to ONE fixed literal (or only ask «is there one»), so there is no address to judge
    const EXACT_COMPARE = new Map<string, string>([
      ['app/(authenticated)/settings/page.tsx', "`return === 'chats'` — one literal"],
      ['components/org-briefing/org-briefing-shell.tsx', '`next` only asks «is there one» (a banner), never navigates to it'],
      ['app/onboarding/page.tsx', '`next` goes through desktopOnboardingNext: equals `/desktop/setup` or is ignored'],
    ]);
    const GOES_THROUGH_THE_FUNCTION = /from '@\/lib\/auth\/internal-path'|from '@\/lib\/auth\/session-redirect'|from '@\/lib\/pair-return'|from '@\/lib\/phone-landing-address'/;
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (rel === THE_FUNCTION) continue;
      const src = readFileSync(f, 'utf8');
      if (!READS_A_TARGET.test(codeOnly(src))) continue;
      if (EXACT_COMPARE.has(rel)) continue;
      if (!GOES_THROUGH_THE_FUNCTION.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the places that turn a `next` · `return` · deeplink into a navigation import the one function', () => {
    const CONSUMERS = [
      'lib/auth/session-redirect.ts', // safeNextPath · buildLoginRedirect — login success · register · native · OAuth callback
      'hooks/use-unified-switcher.ts', // ?next= after picking a project
      'hooks/use-account-switcher.ts', // the add-account response's `redirect`
      'proxy.ts', // the ?next= the proxy plants (project picker · sign-in)
      'app/api/auth/renew/route.ts', // internalPage
      'app/auth/login/route.ts', // the oauth_next cookie is stored only when safe
      'lib/pair-return.ts',
      'lib/phone-landing-address.ts',
      'lib/storage/format.ts', // BE deeplink → href
    ];
    for (const rel of CONSUMERS) {
      expect(readFileSync(join(SRC, rel), 'utf8'), rel).toMatch(/from '@\/lib\/auth\/internal-path'/);
    }
  });

  it('the function file exists and exports the two names the others (4935 settings next) call', () => {
    const code = readFileSync(join(SRC, THE_FUNCTION), 'utf8');
    expect(code).toMatch(/export function isSafeInternalPath\(/);
    expect(code).toMatch(/export function safeInternalPath\(/);
  });
});
