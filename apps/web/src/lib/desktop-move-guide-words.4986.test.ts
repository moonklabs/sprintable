// story 4986 AC5 (threat model 84aaf13e §5) — the words of the move guide: the same keys in both languages, and none of the phrases the product never uses
// (it never «connects an account», «logs in for» a person, or «moves / imports» a login or a token — the person signs in at the new computer).
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const MOVE_KEYS = ['oldComputerNote', 'oldComputerLink', 'afterTitle', 'afterLogin', 'afterOldComputer', 'afterMemo'] as const;
const FORBIDDEN_KO = [/계정\s*(연결|옮기기|가져오기)/, /로그인해\s*드/, /토큰\s*(가져오기|옮기기|복사)/, /로그인\s*(정보)?(을|를)?\s*(가져|옮겨\s*요|복사)/];
const FORBIDDEN_EN = [/(move|transfer|import|copy|connect)\s+(your\s+|the\s+)?(account|token|login|sign-in)\b/i, /log(s)?\s+you\s+in/i];

describe('[SID:4986] the move guide\'s words', () => {
  it('the same keys exist in ko and en (and the devices line too)', () => {
    for (const k of MOVE_KEYS) {
      expect(typeof (ko.desktop.setup.move as Record<string, string>)[k], k).toBe('string');
      expect(typeof (en.desktop.setup.move as Record<string, string>)[k], k).toBe('string');
    }
    expect(ko.desktop.devices.emptyComputer).toBe('에이전트가 없는 컴퓨터예요 — 끊어도 돼요');
    expect(typeof en.desktop.devices.emptyComputer).toBe('string');
  });
  it('no quote marks in the done-screen line (they draw as ≪ ≫ there) — its link text is the only name of the screen', () => {
    expect(ko.desktop.setup.move.oldComputerNote).not.toMatch(/[«»≪≫“”]/);
    expect(en.desktop.setup.move.oldComputerNote).not.toMatch(/[«»≪≫“”]/);
  });
  it('no forbidden phrase in any of them', () => {
    const koWords = [...MOVE_KEYS.map((k) => (ko.desktop.setup.move as Record<string, string>)[k]), ko.desktop.devices.emptyComputer];
    const enWords = [...MOVE_KEYS.map((k) => (en.desktop.setup.move as Record<string, string>)[k]), en.desktop.devices.emptyComputer];
    for (const w of koWords) for (const re of FORBIDDEN_KO) expect(re.test(w), `${re} in «${w}»`).toBe(false);
    for (const w of enWords) for (const re of FORBIDDEN_EN) expect(re.test(w), `${re} in «${w}»`).toBe(false);
  });
  it('the guard really bites: the phrases it forbids are caught', () => {
    expect(FORBIDDEN_KO.some((re) => re.test('계정 옮기기'))).toBe(true);
    expect(FORBIDDEN_KO.some((re) => re.test('토큰 가져오기'))).toBe(true);
    expect(FORBIDDEN_KO.some((re) => re.test('로그인해 드립니다'))).toBe(true);
    expect(FORBIDDEN_EN.some((re) => re.test('Move your account'))).toBe(true);
    expect(FORBIDDEN_EN.some((re) => re.test('We log you in'))).toBe(true);
  });
  it('the memo line uses the web\'s own names — «인계» / handoff (the phone card\'s word; never 퇴근 · 출근 · 메모) — and the button the person sees («모든 세션 시작» / Start all sessions); it is no longer tied to the move itself: after a move the agent starts at once, the handoff comes with that press', () => {
    expect(ko.desktop.setup.move.afterMemo).toBe('지난 인계는 폰의 「모든 세션 시작」으로 세션을 시작할 때 이 컴퓨터의 에이전트에게 참고 글로 넘어가요');
    expect(en.desktop.setup.move.afterMemo).toBe('The last handoff is passed on to this computer\'s agent as a reference when sessions are started with Start all sessions on a phone');
    // the words are the phone card's own button labels (one source of the name)
    expect(ko.desktop.setup.move.afterMemo).toContain(`「${ko.desktop.phoneSessions.startAll}」`);
    expect(en.desktop.setup.move.afterMemo).toContain(en.desktop.phoneSessions.startAll);
    expect(ko.desktop.setup.move.afterMemo).not.toMatch(/첫 출근|퇴근|메모|[«»≪≫]/);
    // «인계» is what the phone card calls it (one name)
    expect(ko.desktop.phoneSessions.panel.leadIdle).toContain('인계');
    expect(ko.desktop.setup.move.afterMemo).toContain('인계');
  });
  it('the login line says what is true: the sign-in is not carried over (ko · en)', () => {
    expect(ko.desktop.setup.move.afterLogin).toContain('로그인 정보는 옮겨지지 않아요');
    expect(en.desktop.setup.move.afterLogin).toContain('not carried over');
    // it names the tools it is told (never a fixed «Claude Code» — a Codex agent is moved on the same screen)
    expect(ko.desktop.setup.move.afterLogin).toMatch(/^\{tools\}\{josa\} /);
    expect(en.desktop.setup.move.afterLogin).toContain('{tools}');
    expect(ko.desktop.setup.move.afterLogin).not.toContain('Claude Code');
    expect(en.desktop.setup.move.afterLogin).not.toContain('Claude Code');
  });
});
