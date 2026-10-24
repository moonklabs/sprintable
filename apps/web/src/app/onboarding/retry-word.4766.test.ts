/**
 * story 4766 AC6 — the 20-minute hint says «다시 시도» but the button said «다시 테스트»: two words for one press (a person looks for a
 * button that is not there). The hint now names the button by the button's own word, in both languages.
 */
import { describe, expect, it } from 'vitest';
import ko from '../../../messages/ko.json';
import en from '../../../messages/en.json';

describe('the verify hint and the retry button speak with one word (story 4766 AC6)', () => {
  it('ko: the hint names «다시 테스트» — the button\'s own label — and no other retry word', () => {
    expect(ko.onboarding.verifyTimeoutHint).toContain(`「${ko.onboarding.verifyRetry}」`);
    expect(ko.onboarding.verifyTimeoutHint).not.toContain('다시 시도');
  });
  it('en: the hint names «Run test» — the button\'s own label — and not «Retry»', () => {
    expect(en.onboarding.verifyTimeoutHint).toContain(en.onboarding.verifyRetry);
    expect(en.onboarding.verifyTimeoutHint).not.toMatch(/\bRetry\b/);
  });
});
