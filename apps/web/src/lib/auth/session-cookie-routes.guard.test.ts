// story 4762 — every ROAD that sets or clears the session cookie (`sp_at`) says so: `markSessionChanged(res)` puts the `x-session-changed` header on the response, the page's
// fetch gate sees it and tells the phone shell, and the shell writes the cookies to disk now (a force-quit seconds after a rotation must not wake the app with the old
// token — measured on an Android phone: the sign-up token, with no organization claim, stayed on disk → `/api/v2/me` 404 `membership_elsewhere` → a Next 404).
// This guard reads the sources: a route file that writes `sp_at` and does not call `markSessionChanged` is red, so a NEW session road cannot forget the signal.
// A file that is not a fetch-answering route is listed below with its reason; each entry must still write `sp_at` (a stale exemption is red too).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { markSessionChanged, SESSION_CHANGED_HEADER } from './cookies';

const SRC = resolve(__dirname, '../..');
// a file that writes the session cookies: directly (`…cookies.set(SP_AT_COOKIE …` · the refresh token too) or through the account-vault helpers that write them
const WRITES_SP_AT = /\.set\(\s*SP_(?:AT|RT)_COOKIE\b|\b(?:discardActiveSession|setActiveAccount|clearAllAccounts)\(/;
/** roads with several response branches that change the session: at least this many marks (a branch added without its mark is not caught by «any mark»; this ratchet pins the known ones) */
const MIN_MARKS: Record<string, number> = {
  'app/api/auth/refresh/route.ts': 2, // success + the clear branch
  'app/api/auth/signout-account/route.ts': 3, // two «no account left» branches + «next account»
  'app/api/auth/switch-account/route.ts': 2, // corrupt-session discard + the swap
  'proxy.ts': 2, // applyTokenCookies + clearAuthCookies — every middleware refresh / clear (also on `/api/*` fetches)
};

/** the document navigations that set cookies on a redirect: not answers to a `fetch()`, so the page's fetch gate never sees a header there — the shell writes cookies out when the page finishes loading (`onPageFinished` → `CookieManager.flush()`, App.js) */
const EXEMPT: Record<string, string> = {
  'app/api/auth/callback/[provider]/route.ts': 'OAuth callback: a top-level navigation answered with a redirect',
  'app/auth/oauth-handoff/route.ts': 'OAuth hand-off into the app: a top-level navigation answered with a redirect',
  'app/auth/native/route.ts': 'native hand-off: a top-level navigation answered with a redirect',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/^route\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(SRC, p).split('\\').join('/');
const candidates = [...walk(join(SRC, 'app')), join(SRC, 'proxy.ts')];
const writers = candidates.filter((p) => WRITES_SP_AT.test(readFileSync(p, 'utf8')));

describe('markSessionChanged', () => {
  it('puts the header on the response it is given and returns that same response', () => {
    const res = NextResponse.json({ data: { ok: true } });
    expect(markSessionChanged(res)).toBe(res);
    expect(res.headers.get(SESSION_CHANGED_HEADER)).toBe('1');
    expect(SESSION_CHANGED_HEADER).toBe('x-session-changed');
  });
});

describe('every route that writes the session cookie tells the shell (story 4762 guard)', () => {
  it('finds the session roads (a refactor that hides them from this scan must not pass silently)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(17);
    for (const must of ['app/api/auth/login/route.ts', 'app/api/auth/register/route.ts', 'app/api/auth/refresh/route.ts', 'app/api/switch-org/route.ts', 'app/api/invites/[token]/accept/route.ts', 'app/api/auth/switch-account/route.ts', 'app/api/auth/add-account/route.ts', 'app/api/accounts/route.ts', 'proxy.ts']) {
      expect(writers.map(rel)).toContain(must);
    }
  });

  it('each one calls markSessionChanged — except the listed document navigations', () => {
    const missing = writers.map(rel).filter((f) => !(f in EXEMPT) && !/\bmarkSessionChanged\(/.test(readFileSync(join(SRC, f), 'utf8')));
    expect(missing, `session roads that set or clear sp_at without markSessionChanged(res):\n${missing.join('\n')}`).toEqual([]);
  });

  it('roads with several branches carry as many marks as the branches that change the session', () => {
    for (const [f, min] of Object.entries(MIN_MARKS)) {
      const marks = (readFileSync(join(SRC, f), 'utf8').match(/\bmarkSessionChanged\(/g) ?? []).length;
      expect(marks, `${f} has ${marks} mark(s), expected at least ${min}`).toBeGreaterThanOrEqual(min);
    }
  });

  it('the exemptions are real: each listed file still writes sp_at (a stale entry hides nothing and must go)', () => {
    for (const f of Object.keys(EXEMPT)) {
      expect(WRITES_SP_AT.test(readFileSync(join(SRC, f), 'utf8')), `${f} no longer writes sp_at — remove it from EXEMPT`).toBe(true);
    }
  });

  it('a route that marks the session also writes it (no dead mark on a road that sets nothing)', () => {
    const marks = candidates.filter((p) => /\bmarkSessionChanged\(/.test(readFileSync(p, 'utf8')));
    const orphan = marks.map(rel).filter((f) => !writers.map(rel).includes(f));
    expect(orphan, `marks a response in a file that never writes sp_at:\n${orphan.join('\n')}`).toEqual([]);
  });
});
