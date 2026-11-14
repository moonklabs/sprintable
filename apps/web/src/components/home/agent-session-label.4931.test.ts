// story #4931 — «에이전트 상태»가 남의 맥 앞 물음에도 «당신의 답»이라 쓰던 것: 내 기기(또는 서버가 말하지 않음)면 지금 문구, 남의 기기면 «당신»을 빼고 «그 맥»이라 말한다.
// (후속 · PO 08:xxZ) 문장에는 기기 이름을 넣지 않는다 — 오른쪽 칸이 같은 행의 다음 줄에 이미 기기 이름을 적는다(두 번 적힘 = 겹침). 한 화면의 «손 필요» 줄과 «에이전트 상태»는 같은 낱말(«기다림»)을 쓴다.
import { describe, expect, it } from 'vitest';
import { sessionStateLabel } from '@/components/chat/agent-session-strip';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const tFor = (m: typeof koMessages) => (key: string) => (key.split('.').reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k], m.chats.agentSession) as string) ?? `MISSING:${key}`;
const asking = { state: 'working', activity: 'working', first_screen: { ask: 'trust' as const } };

describe('sessionStateLabel — 터미널 물음 줄', () => {
  it('내 기기면 지금 문구 그대로(ko · en)', () => {
    expect(sessionStateLabel({ ...asking, device_is_mine: true }, tFor(koMessages))).toBe(koMessages.chats.agentSession.state.waiting_first_screen);
    expect(sessionStateLabel({ ...asking, device_is_mine: true }, tFor(enMessages))).toBe(enMessages.chats.agentSession.state.waiting_first_screen);
  });

  it('서버가 «내 기기인가»를 말하지 않으면(옛 서버 · DM 줄 · 일꾼 상세) 지금 문구 그대로', () => {
    expect(sessionStateLabel({ ...asking }, tFor(koMessages))).toBe(koMessages.chats.agentSession.state.waiting_first_screen);
  });

  it('⭐남의 기기면 «당신»을 빼고 «그 맥»이라 말한다 — 기기 이름은 문장에 한 번도 없다(0번)', () => {
    const view = { ...asking, device_is_mine: false, device_name: 'ZZ-맥-이름', bound_device_name: 'ZZ-맥-이름' }; // the row carries its computer's name; the sentence must not repeat it
    const ko = sessionStateLabel(view, tFor(koMessages));
    const en = sessionStateLabel(view, tFor(enMessages));
    expect(ko).toBe('그 맥에서 답을 기다려요');
    expect(en).toBe('Waiting for an answer on that Mac');
    for (const s of [ko, en]) expect(s.split('ZZ-맥-이름').length - 1, '기기 이름이 문장에 들어 있다').toBe(0);
    expect(enMessages.chats.agentSession.state.waiting_first_screen_other).not.toMatch(/\byour\b|\{/i);
    expect(koMessages.chats.agentSession.state.waiting_first_screen_other).not.toMatch(/당신|\{/);
  });

  it('물음이 없으면 남의 기기여도 평소 말(작업 중)이다', () => {
    expect(sessionStateLabel({ state: 'working', activity: 'working', first_screen: null, device_is_mine: false }, tFor(koMessages))).toBe(koMessages.chats.agentSession.state.working);
  });

  it('⭐한 화면의 두 자리가 같은 낱말을 쓴다 — 손 필요 줄(home.kindTerminalWait)과 «에이전트 상태»(waiting_first_screen) 모두 «기다림» 한 꼴, «대기»는 없다(ko)', () => {
    const line = koMessages.home.kindTerminalWait;
    const status = koMessages.chats.agentSession.state.waiting_first_screen;
    expect(status).toBe(line);
    for (const s of [line, status, koMessages.chats.agentSession.state.waiting_first_screen_other]) { expect(s).toContain('기다'); expect(s).not.toContain('대기'); }
    // en says «Waiting» in both places already
    expect(enMessages.home.kindTerminalWait).toMatch(/^Waiting/);
    expect(enMessages.chats.agentSession.state.waiting_first_screen).toMatch(/^Waiting/);
  });
});
