import { describe, expect, it } from 'vitest';
import { appReturnUrl, appScheme, appSetupLink, nativeReturnApp } from './native-return-app';

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
