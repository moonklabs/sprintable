// story 4712 — «브라우저 이어받기»: the app's start parameters are checked as a CLOSED set (Kadir v2 ①): off by one character, one method, one mode or
// one app name and the whole start is refused — nothing is partly accepted, and the route never calls the issue for a refused start.
import { describe, expect, it } from 'vitest';
import { CONTINUE_CHALLENGE_RE, continueQuery, continueReturnPath, parseContinueStart } from './desktop-continue';

const CH = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // 43 chars, the RFC 7636 appendix B challenge
const q = (o: Record<string, string>) => new URLSearchParams(o);
const good = { code_challenge: CH, cc_method: 'S256', callback_mode: 'custom_scheme' };

describe('parseContinueStart', () => {
  it('takes exactly the app\'s start: a 43-character S256 challenge · S256 · custom_scheme (no return_app = the host default)', () => {
    expect(CH).toHaveLength(43);
    expect(parseContinueStart(q(good))).toEqual({ challenge: CH, returnApp: null });
  });

  it.each([
    ['dev', 'dev'], ['check', 'check'],
  ] as const)('return_app=%s is in the table', (v, expected) => {
    expect(parseContinueStart(q({ ...good, return_app: v }))).toEqual({ challenge: CH, returnApp: expected });
  });

  it.each([
    ['prod'], ['DEV'], ['Check'], [''], ['ai.sprintable'], ['dev '], ['https://evil.example'],
  ])('return_app=%j is off the table → the whole start is refused (never defaulted)', (v) => {
    expect(parseContinueStart(q({ ...good, return_app: v }))).toBeNull();
  });

  it.each([
    ['42 characters', CH.slice(0, 42)],
    ['44 characters', `${CH}A`],
    ['a character outside base64url', `${CH.slice(0, 42)}+`],
    ['padding', `${CH.slice(0, 42)}=`],
    ['empty', ''],
  ])('a challenge of %s is refused', (_n, challenge) => {
    expect(parseContinueStart(q({ ...good, code_challenge: challenge }))).toBeNull();
  });

  it('a missing challenge, a method other than S256 (or none) and a mode other than custom_scheme (https · none) are refused', () => {
    const { code_challenge: _c, ...noChallenge } = good;
    expect(parseContinueStart(q(noChallenge))).toBeNull();
    expect(parseContinueStart(q({ ...good, cc_method: 'plain' }))).toBeNull();
    const { cc_method: _m, ...noMethod } = good;
    expect(parseContinueStart(q(noMethod))).toBeNull();
    expect(parseContinueStart(q({ ...good, callback_mode: 'https' }))).toBeNull();
    const { callback_mode: _b, ...noMode } = good;
    expect(parseContinueStart(q(noMode))).toBeNull();
  });

  it('the challenge pattern is exactly 43 base64url characters', () => {
    expect(CONTINUE_CHALLENGE_RE.test(CH)).toBe(true);
    expect(CONTINUE_CHALLENGE_RE.test(`${CH}\n`)).toBe(false);
  });
});

describe('continueQuery · continueReturnPath', () => {
  it('the page keeps the start in its own address, and what it parses back is the same start', () => {
    for (const returnApp of [null, 'dev', 'check'] as const) {
      const start = { challenge: CH, returnApp };
      expect(parseContinueStart(new URLSearchParams(continueQuery(start)))).toEqual(start);
    }
  });

  it('the hand-over address is the existing return page with the code (and `app` only for a table app)', () => {
    expect(continueReturnPath('abc_DEF-123', null)).toBe('/native/oauth-return?code=abc_DEF-123');
    expect(continueReturnPath('abc_DEF-123', 'dev')).toBe('/native/oauth-return?code=abc_DEF-123&app=dev');
    expect(continueReturnPath('a b&c', 'check')).toBe('/native/oauth-return?code=a+b%26c&app=check');
  });
});
