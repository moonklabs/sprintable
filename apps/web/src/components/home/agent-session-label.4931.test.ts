// story #4931 — «에이전트 상태»가 남의 맥 앞 물음에도 «당신의 답»이라 쓰던 것: 내 기기(또는 서버가 말하지 않음)면 지금 문구, 남의 기기면 «당신»을 빼고 그 맥 이름을 말한다.
import { describe, expect, it } from 'vitest';
import { sessionStateLabel } from '@/components/chat/agent-session-strip';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const tFor = (m: typeof koMessages) => (key: string, values?: Record<string, string>) => {
  const s = (key.split('.').reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k], m.chats.agentSession) as string) ?? `MISSING:${key}`;
  return values ? s.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '') : s;
};
const asking = { state: 'working', activity: 'working', first_screen: { ask: 'trust' as const } };

describe('sessionStateLabel — 터미널 물음 줄', () => {
  it('내 기기면 지금 문구 그대로(ko · en)', () => {
    expect(sessionStateLabel({ ...asking, device_is_mine: true, device_name: '맥 A' }, tFor(koMessages))).toBe(koMessages.chats.agentSession.state.waiting_first_screen);
    expect(sessionStateLabel({ ...asking, device_is_mine: true, device_name: 'Mac A' }, tFor(enMessages))).toBe(enMessages.chats.agentSession.state.waiting_first_screen);
  });

  it('서버가 «내 기기인가»를 말하지 않으면(옛 서버 · DM 줄 · 일꾼 상세) 지금 문구 그대로', () => {
    expect(sessionStateLabel({ ...asking, device_name: '맥 A' }, tFor(koMessages))).toBe(koMessages.chats.agentSession.state.waiting_first_screen);
  });

  it('⭐남의 기기면 «당신»을 빼고 그 맥 이름을 말한다 — «그 맥에서 답을 기다려요(맥 A)»', () => {
    expect(sessionStateLabel({ ...asking, device_is_mine: false, device_name: '맥 A' }, tFor(koMessages))).toBe('그 맥에서 답을 기다려요 (맥 A)');
    expect(sessionStateLabel({ ...asking, device_is_mine: false, device_name: 'Mac A' }, tFor(enMessages))).toBe('Waiting for an answer on that Mac (Mac A)');
    // the words never say «your» answer for someone else's Mac
    expect(enMessages.chats.agentSession.state.waiting_first_screen_other).not.toMatch(/\byour\b/i);
    expect(koMessages.chats.agentSession.state.waiting_first_screen_other).not.toContain('당신');
  });

  it('기기 이름이 없으면 빈 괄호를 쓰지 않고 이름 없는 문장을 쓴다', () => {
    const ko = sessionStateLabel({ ...asking, device_is_mine: false, device_name: null, bound_device_name: '  ' }, tFor(koMessages));
    expect(ko).toBe('그 맥에서 답을 기다려요');
    expect(ko).not.toContain('(');
  });

  it('물음이 없으면 남의 기기여도 평소 말(작업 중)이다', () => {
    expect(sessionStateLabel({ state: 'working', activity: 'working', first_screen: null, device_is_mine: false, device_name: '맥 A' }, tFor(koMessages))).toBe(koMessages.chats.agentSession.state.working);
  });
});
