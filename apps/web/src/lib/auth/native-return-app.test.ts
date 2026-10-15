import { afterEach, describe, expect, it, vi } from 'vitest';
import { appReturnUrl, appScheme, appSetupLink, defaultScheme, nativeReturnApp } from './native-return-app';

// story #4626 (PO 08:04Z): which desktop app a hand-back opens — a closed table. A value outside it is the default, and no
// string from the URL ever reaches a link.
describe('native-return-app — story #4626', () => {
  it('the table: «check» → ai.sprintable.check · none → ai.sprintable', () => {
    expect(nativeReturnApp('check')).toBe('check');
    expect(appScheme('check')).toBe('ai.sprintable.check');
    expect(appScheme(null)).toBe('ai.sprintable');
  });

  it('⭐a value outside the table → the default · no free string: another name · a scheme · empty · another case · padded · a list', () => {
    // Kadir 08:18Z: look-alikes too — full-width letters · a Cyrillic «с» · a zero-width space · a trailing newline
    for (const v of ['evil', 'ai.sprintable.check', 'ai.sprintable.check:', 'ai.sprintable.dev', 'DEV', 'Dev', ' dev', 'dev ', 'dev\n', 'dev,check', 'ｄｅｖ', 'dеv', 'CHECK', 'Check', ' check', 'check ', 'check,setup', '', 'setup', 'javascript',
      'ｃｈｅｃｋ', 'сheck', 'check​', 'check\n', null, undefined]) {
      expect(nativeReturnApp(v), String(v)).toBeNull();
    }
    // and whatever came in `app`, the link is exactly the default one — nothing of the value is in it
    for (const v of ['evil', 'javascript:alert(1)//', 'https://example.com', 'ai.sprintable.check', 'ai.sprintable.dev', 'DEV']) {
      expect(appReturnUrl(new URLSearchParams({ code: 'abc', app: v })), v).toBe('ai.sprintable:/oauth-return?code=abc');
    }
  });

  it('⭐no `app`: the return link is the one from before, byte for byte (the query as it came)', () => {
    expect(appReturnUrl(new URLSearchParams('code=abc123'))).toBe('ai.sprintable:/oauth-return?code=abc123');
    expect(appReturnUrl(new URLSearchParams('code=abc123&state=xyz'))).toBe('ai.sprintable:/oauth-return?code=abc123&state=xyz');
    expect(appReturnUrl(new URLSearchParams(''))).toBe('ai.sprintable:/oauth-return');
  });

  it('`app=check`: the check app\'s scheme · `app` itself is not handed on · the rest is', () => {
    expect(appReturnUrl(new URLSearchParams('code=abc123&app=check'))).toBe('ai.sprintable.check:/oauth-return?code=abc123');
    expect(appReturnUrl(new URLSearchParams('app=check&code=abc123&state=xyz'))).toBe('ai.sprintable.check:/oauth-return?code=abc123&state=xyz');
    expect(appReturnUrl(new URLSearchParams('app=evil&code=abc123'))).toBe('ai.sprintable:/oauth-return?code=abc123');
  });

  // story 4689 (PO 10-15): the dev phone app — its own scheme so the return button never opens the prod app (or a chooser) on a phone that has both
  it('[4689] `dev` is in the table: ai.sprintable.dev · the prod/default link is unchanged · `app` itself is not handed on', () => {
    expect(nativeReturnApp('dev')).toBe('dev');
    expect(appScheme('dev')).toBe('ai.sprintable.dev');
    expect(appScheme('dev')).not.toBe(appScheme(null));
    expect(appScheme('dev')).not.toBe(appScheme('check'));
    expect(appScheme(null)).toBe('ai.sprintable');
    expect(appReturnUrl(new URLSearchParams('code=abc123&app=dev'))).toBe('ai.sprintable.dev:/oauth-return?code=abc123');
    expect(appReturnUrl(new URLSearchParams('app=dev&code=abc123&state=xyz'))).toBe('ai.sprintable.dev:/oauth-return?code=abc123&state=xyz');
    // the prod phone app sends no `app` → exactly the link from before
    expect(appReturnUrl(new URLSearchParams('code=abc123'))).toBe('ai.sprintable:/oauth-return?code=abc123');
  });

  it('the setup links: none → the two from before · check → the same paths on the check app\'s scheme', () => {
    expect(appSetupLink(null)).toBe('ai.sprintable:/desktop/setup');
    expect(appSetupLink(null, 'reopen')).toBe('ai.sprintable:/desktop/setup?intent=reopen');
    expect(appSetupLink('check')).toBe('ai.sprintable.check:/desktop/setup');
    expect(appSetupLink('check', 'reopen')).toBe('ai.sprintable.check:/desktop/setup?intent=reopen');
    // story 4670 (PR 5066 · merged shape): `pair` opens the app's phone pairing · intent wins over an agent
    expect(appSetupLink(null, 'pair')).toBe('ai.sprintable:/desktop/setup?intent=pair');
    expect(appSetupLink(null, 'pair', { agent: 'a1111111-0000-4000-8000-000000000001' })).toBe('ai.sprintable:/desktop/setup?intent=pair');
    // story 4680 (D2 · 4677): the recruiter's [이 컴퓨터에서 시작] from a browser — `?agent=<uuid>`; a value off the shape never goes in
    expect(appSetupLink(null, undefined, { agent: 'a1111111-0000-4000-8000-000000000001' })).toBe('ai.sprintable:/desktop/setup?agent=a1111111-0000-4000-8000-000000000001');
    expect(appSetupLink(null, undefined, { agent: '../x' })).toBe('ai.sprintable:/desktop/setup');
    expect(appSetupLink(null, undefined, { agent: null })).toBe('ai.sprintable:/desktop/setup');
  });
});

// story 4696 (PO 10-15): the Mac's «Sprintable Dev Setup» registers `ai.sprintable.dev` only and our crew's Macs have it alone, so on the DEV web a
// link handed out without an `app` (a plain browser tab) must default to `ai.sprintable.dev` — or nobody opens it. The default is by the build's own
// public address (NEXT_PUBLIC_APP_URL — the same source as phone-app-store.ts). The production web is byte for byte as before.
describe('native-return-app — story 4696: the default scheme by host', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('⭐exactly the dev web\'s host → ai.sprintable.dev · the production host and everything else → ai.sprintable', () => {
    for (const u of ['https://dev-app.sprintable.ai', 'https://dev-app.sprintable.ai/', 'https://dev-app.sprintable.ai:443/x?y=1', 'HTTPS://DEV-APP.SPRINTABLE.AI']) {
      expect(defaultScheme(u), u).toBe('ai.sprintable.dev');
    }
    for (const u of ['https://app.sprintable.ai', 'https://app.sprintable.ai/', 'http://localhost:3000', 'http://127.0.0.1:3000', 'https://staging-app.sprintable.ai',
      'https://dev-app.sprintable.ai.evil.example', 'https://evil.example/dev-app.sprintable.ai', 'https://xdev-app.sprintable.ai', 'https://dev-app.sprintable.aix',
      'https://user@evil.example/?h=dev-app.sprintable.ai', 'dev-app.sprintable.ai', 'not a url', '', undefined]) {
      expect(defaultScheme(u), String(u)).toBe('ai.sprintable');
    }
  });

  it('the build\'s own address is read at call time (vi.stubEnv) — unset → the prod default, so every older test stays as it was', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(appScheme(null)).toBe('ai.sprintable');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-app.sprintable.ai');
    expect(appScheme(null)).toBe('ai.sprintable.dev');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.sprintable.ai');
    expect(appScheme(null)).toBe('ai.sprintable');
  });

  it('⭐dev web: no `app` → every link of the page goes to ai.sprintable.dev (return · setup · reopen · pair · agent)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-app.sprintable.ai');
    expect(appReturnUrl(new URLSearchParams('code=abc123'))).toBe('ai.sprintable.dev:/oauth-return?code=abc123');
    expect(appReturnUrl(new URLSearchParams('code=abc123&state=xyz'))).toBe('ai.sprintable.dev:/oauth-return?code=abc123&state=xyz');
    expect(appReturnUrl(new URLSearchParams(''))).toBe('ai.sprintable.dev:/oauth-return');
    expect(appSetupLink(null)).toBe('ai.sprintable.dev:/desktop/setup');
    expect(appSetupLink(null, 'reopen')).toBe('ai.sprintable.dev:/desktop/setup?intent=reopen');
    expect(appSetupLink(null, 'pair')).toBe('ai.sprintable.dev:/desktop/setup?intent=pair');
    expect(appSetupLink(null, undefined, { agent: 'a1111111-0000-4000-8000-000000000001' })).toBe('ai.sprintable.dev:/desktop/setup?agent=a1111111-0000-4000-8000-000000000001');
  });

  it('⭐dev web: a value outside the table is «no value» → the host\'s default, never the value · the table\'s own values stay as they are', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dev-app.sprintable.ai');
    for (const v of ['evil', 'javascript:alert(1)//', 'ai.sprintable.check', 'ai.sprintable', 'DEV', 'CHECK', ' dev', '']) {
      expect(appReturnUrl(new URLSearchParams({ code: 'abc', app: v })), v).toBe('ai.sprintable.dev:/oauth-return?code=abc');
    }
    expect(appReturnUrl(new URLSearchParams('code=abc&app=check'))).toBe('ai.sprintable.check:/oauth-return?code=abc');   // the check app keeps its own
    expect(appReturnUrl(new URLSearchParams('code=abc&app=dev'))).toBe('ai.sprintable.dev:/oauth-return?code=abc');
    expect(appSetupLink('check')).toBe('ai.sprintable.check:/desktop/setup');
    expect(appSetupLink('dev')).toBe('ai.sprintable.dev:/desktop/setup');
  });

  it('⭐production web: byte for byte as before — every default link is ai.sprintable:', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.sprintable.ai');
    expect(appReturnUrl(new URLSearchParams('code=abc123'))).toBe('ai.sprintable:/oauth-return?code=abc123');
    expect(appReturnUrl(new URLSearchParams('code=abc&app=evil'))).toBe('ai.sprintable:/oauth-return?code=abc');
    expect(appSetupLink(null)).toBe('ai.sprintable:/desktop/setup');
    expect(appSetupLink(null, 'reopen')).toBe('ai.sprintable:/desktop/setup?intent=reopen');
    expect(appSetupLink(null, 'pair')).toBe('ai.sprintable:/desktop/setup?intent=pair');
    expect(appSetupLink(null, undefined, { agent: 'a1111111-0000-4000-8000-000000000001' })).toBe('ai.sprintable:/desktop/setup?agent=a1111111-0000-4000-8000-000000000001');
    expect(appReturnUrl(new URLSearchParams('code=abc&app=check'))).toBe('ai.sprintable.check:/oauth-return?code=abc');
    expect(appSetupLink('dev')).toBe('ai.sprintable.dev:/desktop/setup');   // an explicit `dev` (the dev phone app · Dev Setup) is the same on any host
  });
});
