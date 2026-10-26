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
    // the stuck-for-20-minutes hint never pushes the person to allow anything (permission is theirs, and it is not what the screen waits for — the first call is)
    expect(ko.onboarding.advanced.timeoutHint).not.toMatch(/허용/);
    expect(en.onboarding.advanced.timeoutHint).not.toMatch(/allow/i);
    // what it does name is the real dead end measured on dev: Claude Code quitting at the folder question
    expect(ko.onboarding.advanced.timeoutHint).toContain('폴더를 믿을지 묻는 곳'); // the SAME words the next-step sentence uses for the one thing (Yuna)
    expect(ko.onboarding.advanced.timeoutHint).toContain('종료되지'); // a program ends («종료»); «꺼짐» is for switches
    expect(ko.onboarding.advanced.timeoutHint).not.toMatch(/꺼지/);
    expect(en.onboarding.advanced.timeoutHint).toContain('the question about trusting the folder');
    // only what was measured is claimed: the folder question ending a session is measured for Claude Code, not for Codex — the Codex hint says nothing of it
    for (const h of [ko.onboarding.advanced.timeoutHintCodex, en.onboarding.advanced.timeoutHintCodex]) expect(h).not.toMatch(/폴더|folder|Claude Code/);
    expect(ko.onboarding.advanced.timeoutHintCodex).toContain(`「${ko.onboarding.verifyRetry}」`);
    expect(en.onboarding.advanced.timeoutHintCodex).toContain(en.onboarding.verifyRetry);
    expect(ko.onboarding.advanced.timeoutHintCodex).not.toMatch(/허용/);
    expect(en.onboarding.advanced.timeoutHintCodex).not.toMatch(/allow/i);
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
    expect(adv.nextClaude.indexOf('폴더를 믿을지')).toBeLessThan(adv.nextClaude.indexOf('도구를 써도')); // (the full order is pinned in the next test)
    expect(adv.nextClaude).toContain('폴더가 내 것이면'); // trust is the person's call: the line never says «always Yes» (Kadir)
    expect(advEn.nextClaude).toContain('a folder of yours');
    expect(adv.nextCodex).not.toContain('폴더');
    expect(advEn.nextClaude.indexOf('trust the folder')).toBeLessThan(advEn.nextClaude.indexOf('use a tool'));
    expect(advEn.nextCodex).not.toContain('folder');
  });

  /**
   * story 4766 AC8 — the sentence is told in the order it happens (measured on dev, Claude Code 2.1.310, default permission mode): the folder question →
   * the server sees the first call and the screen turns «연결 확인 완료» (before any tool question) → THEN the first message makes the agent ask to use a
   * tool, one question per tool. Nothing may read as «allowing makes the screen change», and the allow is the person's call (the product never says «allow»).
   */
  it('AC8 the order told is the order that happens: folder question → «연결 확인 완료» → tool questions; allowing is the person\'s call', () => {
    for (const [text, verified, tool, trust] of [
      [adv.nextClaude, `«${ko.onboarding.railVerified}»`, '도구를 써도', '폴더를 믿을지'],
      [advEn.nextClaude, `“${en.onboarding.railVerified}”`, 'use a tool', 'trust the folder'],
    ] as const) {
      expect(text.indexOf(trust)).toBeGreaterThan(-1);
      expect(text.indexOf(verified)).toBeGreaterThan(-1);
      expect(text.indexOf(tool)).toBeGreaterThan(-1);
      expect(text.indexOf(trust)).toBeLessThan(text.indexOf(verified));
      expect(text.indexOf(verified)).toBeLessThan(text.indexOf(tool));
    }
    for (const [text, verified, tool] of [
      [adv.nextCodex, `«${ko.onboarding.railVerified}»`, '도구를 써도'],
      [advEn.nextCodex, `“${en.onboarding.railVerified}”`, 'use a tool'],
    ] as const) { expect(text.indexOf(verified)).toBeGreaterThan(-1); expect(text.indexOf(tool)).toBeGreaterThan(-1); expect(text.indexOf(verified)).toBeLessThan(text.indexOf(tool)); }
    // placeholders: {sentence} in all four, {yes} only in the Claude lines (the folder question is the one measured)
    for (const t of [adv.nextClaude, adv.nextCodex, advEn.nextClaude, advEn.nextCodex]) expect(t).toContain('{sentence}');
    for (const t of [adv.nextClaude, advEn.nextClaude]) expect(t).toContain('{yes}');
    for (const t of [adv.nextCodex, advEn.nextCodex]) expect(t).not.toContain('{yes}');
    // the old order's tell: «allow … then this screen turns» (and a push to allow)
    for (const t of [adv.nextClaude, adv.nextCodex]) { expect(t).not.toMatch(/허용해 주세요/); expect(t).not.toMatch(/그러면 이 화면/); expect(t).toContain('직접 정해'); }
    for (const t of [advEn.nextClaude, advEn.nextCodex]) { expect(t).not.toMatch(/allow it —/i); expect(t).toContain('your call'); }
    // the «after that» sentence names its subject (an «it» right after «this screen» reads as the screen — Yuna)
    expect(adv.nextClaude).toContain('그 뒤 Claude Code가'); expect(adv.nextCodex).toContain('그 뒤 Codex가');
    expect(advEn.nextClaude).toContain('After that, if Claude Code asks'); expect(advEn.nextCodex).toContain('After that, if Codex asks');
  });
});
