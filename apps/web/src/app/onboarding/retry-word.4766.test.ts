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

  it('the advanced path has its OWN hint (nobody restarts anything or saves a settings file there) and it too names the button by its word', () => {
    expect(ko.onboarding.advanced.timeoutHint).toContain(`「${ko.onboarding.verifyRetry}」`);
    expect(ko.onboarding.advanced.timeoutHint).not.toMatch(/재시작|저장/);
    expect(en.onboarding.advanced.timeoutHint).toContain(en.onboarding.verifyRetry);
    expect(en.onboarding.advanced.timeoutHint).not.toMatch(/restart|saved/i);
  });
});

/**
 * story 4766 — Yuna's copy review (PR 5206): the words this screen uses are the product's words, and nothing points at a place that is not there.
 */
describe('the advanced path speaks the product\'s words (copy review · story 4766)', () => {
  const adv = ko.onboarding.advanced;
  const advEn = en.onboarding.advanced;
  const all = (o: unknown): string[] => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(all) : []);

  it('a key is «무효화» (the key manager\'s word), never «폐기»', () => {
    for (const v of all(adv)) expect(v).not.toContain('폐기');
    expect(adv.revoke).toBe('키 무효화');
  });

  it('no sentence points at a menu name that does not exist («설정 › 멤버» · «설정 › 에이전트»)', () => {
    for (const v of [...all(adv), ...all(advEn)]) expect(v).not.toMatch(/설정 ›|Settings ›/);
    expect(adv.failure.hosted).toContain('에이전트 메뉴');
    expect(adv.revokeFailed).toContain('에이전트 메뉴');
  });

  it('the verified word is the rail\'s own («연결 확인 완료»), not «연결됨»; «설치», not «깔»', () => {
    expect(adv.nextClaude).toContain(`«${ko.onboarding.railVerified}»`);
    expect(adv.nextCodex).toContain(`«${ko.onboarding.railVerified}»`);
    for (const v of all(adv)) { expect(v).not.toContain('연결됨'); expect(v).not.toMatch(/깔/); expect(v).not.toContain('셸 기록'); }
  });

  it('after a revoke the sentence does not point at «위 명령» (the block is not drawn then)', () => {
    expect(adv.revokedNote).not.toContain('위 명령');
    expect(advEn.revokedNote).not.toMatch(/above/i);
  });

  it('the session line is the session-expired dialog\'s word', () => {
    expect(ko.onboarding.sessionExpired).toBe('세션이 만료됐어요');
    expect(en.onboarding.sessionExpired).toBe('Your session expired');
  });

  it('the Claude line carries the folder-trust clause BEFORE the tool permission; Codex (not measured) does not', () => {
    expect(adv.nextClaude).toContain('{yes}');
    expect(adv.nextClaude.indexOf('폴더를 믿을지')).toBeGreaterThan(-1);
    expect(adv.nextClaude.indexOf('폴더를 믿을지')).toBeLessThan(adv.nextClaude.indexOf('도구를 써도'));
    expect(adv.nextCodex).not.toContain('폴더');
    expect(advEn.nextClaude.indexOf('trust the folder')).toBeLessThan(advEn.nextClaude.indexOf('use the tool'));
    expect(advEn.nextCodex).not.toContain('folder');
  });
});
