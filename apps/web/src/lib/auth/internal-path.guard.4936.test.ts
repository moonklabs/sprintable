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
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !/\.(test|spec)\.|\.test-helper\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// The lines of a source file that are CODE: whole-line comments (line comments, block-comment lines, doc-comment lines) are left out, nothing else is parsed — so a regex literal or an odd string can never hide a guard from
// this reader (a trailing comment that merely MENTIONS the pattern on a code line is read as code: conservative on purpose — reword the comment).
export function codeOnly(src: string): string {
  let inBlock = false;
  let inTemplate = false; // a multi-line template literal: its lines are CODE (data), whatever they start with
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) { inBlock = false; const rest = t.slice(t.indexOf('*/') + 2).trim(); if (rest) out.push(rest); } continue; }
    if (!inTemplate) {
      if (t.startsWith('//')) continue;
      if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; else { const rest = t.slice(t.indexOf('*/') + 2).trim(); if (rest) out.push(rest); } continue; }
    }
    out.push(line);
    const ticks = (line.match(/(?<!\\)`/g) ?? []).length;
    if (ticks % 2 === 1) inTemplate = !inTemplate;
  }
  return out.join('\n');
}

const BLOCK = '(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)*'; // a block comment may sit between the parenthesis and the literal
const SLASH_SLASH = new RegExp(`startsWith\\(\\s*${BLOCK}['"\`]\\/\\/['"\`]\\s*${BLOCK}\\)`);
// `startsWith('/')` and `includes('\\')` near each other (either order, a screenful apart at most) = the other shape of the same hand-written copy
const SLASH_AND_BACKSLASH = /startsWith\(\s*['"`]\/['"`]\s*\)[\s\S]{0,800}includes\(\s*['"`]\\\\['"`]\s*\)|includes\(\s*['"`]\\\\['"`]\s*\)[\s\S]{0,800}startsWith\(\s*['"`]\/['"`]\s*\)/;

describe('the comment reader of this guard', () => {
  it('drops whole-line comments (line · block · doc) and keeps everything on a code line — even after a regex literal or a string holding `//`', () => {
    expect(codeOnly("const marker = ' //'; if (next.startsWith('//')) go(); // trailing\n// next.startsWith('//')\n/* next.startsWith('//') */\n/**\n * next.startsWith('//')\n */\nok();")).toMatch(SLASH_SLASH);
    expect(codeOnly("// next.startsWith('//')\n/* next.startsWith('//') */\n/**\n * next.startsWith('//')\n */\nok();")).not.toMatch(SLASH_SLASH);
    expect(codeOnly("const r = /[//]/; if (next.startsWith('//') && !next.includes('\\\\')) go();")).toMatch(SLASH_SLASH);
    expect(codeOnly('if (next\n  .startsWith(\n    "//"\n  )) go();')).toMatch(SLASH_SLASH);
    expect(codeOnly("if (next.startsWith(/* why */ '//')) go();")).toMatch(SLASH_SLASH);
    expect(codeOnly('const t = `\n// not a comment, a template line\nif (next.startsWith(\'//\')) go();\n`;')).toMatch(SLASH_SLASH);
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
    const NAMES = 'next|return|returnTo|return_to|returnUrl|redirect|redirect_to|redirectTo|redirect_uri|redirect_path|callbackUrl|callback_url|continue|dest|from';
    const READS_A_TARGET = new RegExp(`\\.get\\(\\s*['"\`](?:${NAMES})['"\`]\\s*\\)|\\bredirect_path\\b|\\b(?:searchParams|params|query|body)\\??\\.(?:${NAMES})\\b|\\b(?:searchParams|params|query|body)\\??\\??\\.?\\[\\s*['"\`](?:${NAMES})['"\`]\\s*\\]|(?:const|let)\\s*\\{[^{}]*\\b(?:${NAMES})\\b[^{}]*\\}\\s*=\\s*(?:await\\s+)?(?:searchParams|params|props\\.searchParams)`);
    // they read the value but only compare it to ONE fixed literal (or only ask «is there one»), so there is no address to judge
    const EXACT_COMPARE = new Map<string, string>([
      ['app/(authenticated)/settings/page.tsx', "`return === 'chats'` — one literal"],
      ['components/org-briefing/org-briefing-shell.tsx', '`next` only asks «is there one» (a banner), never navigates to it'],
      ['app/onboarding/page.tsx', '`next` goes through desktopOnboardingNext: equals `/desktop/setup` or is ignored'],
      ['app/(authenticated)/chats/[conversation_id]/page.tsx', '`from` is a project id (isValidProjectId), never an address'],
      ['app/phone-landing/page.tsx', '`next` is only handed to PhoneLanding, which navigates through landingHome (the places that navigate are checked below)'],
    ]);
    // importing is not enough: the file must CALL what it imported (a stray import of session-redirect that is never used would pass an import check)
    const usesTheFunction = (src: string): boolean => {
      const code = codeOnly(src);
      return (/from '@\/lib\/auth\/internal-path'/.test(src) && /\b(?:isSafeInternalPath|safeInternalPath)\(/.test(code))
        || (/from '@\/lib\/auth\/session-redirect'/.test(src) && /\b(?:safeNextPath|buildLoginRedirect)\(/.test(code))
        || (/from '@\/lib\/pair-return'/.test(src) && /\bsafeReturnPath\(/.test(code))
        || (/from '@\/lib\/phone-landing-address'/.test(src) && /\blandingHome\(/.test(code));
    };
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (rel === THE_FUNCTION) continue;
      const src = readFileSync(f, 'utf8');
      if (!READS_A_TARGET.test(codeOnly(src))) continue;
      if (EXACT_COMPARE.has(rel)) continue;
      if (!usesTheFunction(src)) offenders.push(rel);
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
