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
    for (const v of ['evil', 'ai.sprintable.check', 'ai.sprintable.check:', 'CHECK', 'Check', ' check', 'check ', 'check,setup', '', 'setup', 'javascript',
      'ｃｈｅｃｋ', 'сheck', 'check​', 'check\n', null, undefined]) {
      expect(nativeReturnApp(v), String(v)).toBeNull();
    }
    // and whatever came in `app`, the link is exactly the default one — nothing of the value is in it
    for (const v of ['evil', 'javascript:alert(1)//', 'https://example.com', 'ai.sprintable.check']) {
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

  it('the setup links: none → the two from before · check → the same paths on the check app\'s scheme', () => {
    expect(appSetupLink(null)).toBe('ai.sprintable:/desktop/setup');
    expect(appSetupLink(null, 'reopen')).toBe('ai.sprintable:/desktop/setup?intent=reopen');
    expect(appSetupLink('check')).toBe('ai.sprintable.check:/desktop/setup');
    expect(appSetupLink('check', 'reopen')).toBe('ai.sprintable.check:/desktop/setup?intent=reopen');
  });
});
