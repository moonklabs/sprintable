import { describe, expect, it } from 'vitest';
import { resolveNavV3Destinations, type NavV3Flags } from './nav-v3-destinations';

// story #4003 AC3 — 플래그 3개(2^3=8조합) × 항목(오늘·대화·연결·규칙) 목적지 표.
// 각 항목은 자신의 플래그에만 반응하고 다른 두 플래그와 독립이어야 한다(교차 오염 0).
const COMBOS: Array<{ flags: NavV3Flags; today: string; chats: string; connectRules: string | null }> = [
  { flags: { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false }, today: '/org-briefing', chats: '/chats', connectRules: null },
  { flags: { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false }, today: '/today', chats: '/chats', connectRules: null },
  { flags: { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false }, today: '/org-briefing', chats: '/chat', connectRules: null },
  { flags: { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true }, today: '/org-briefing', chats: '/chats', connectRules: '/connect-rules' },
  { flags: { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: false }, today: '/today', chats: '/chat', connectRules: null },
  { flags: { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: true }, today: '/today', chats: '/chats', connectRules: '/connect-rules' },
  { flags: { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: true }, today: '/org-briefing', chats: '/chat', connectRules: '/connect-rules' },
  { flags: { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true }, today: '/today', chats: '/chat', connectRules: '/connect-rules' },
];

describe('resolveNavV3Destinations — 플래그 8조합 표(story #4003 AC1/AC3)', () => {
  it.each(COMBOS)('$flags → today=$today chats=$chats connectRules=$connectRules', ({ flags, today, chats, connectRules }) => {
    const result = resolveNavV3Destinations(flags);
    expect(result).toEqual({ today, chats, connectRules });
  });

  it('⭐전부 OFF — 지금 develop과 바이트 동일 경로(회귀 0 기준선)', () => {
    const result = resolveNavV3Destinations({ todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false });
    expect(result).toEqual({ today: '/org-briefing', chats: '/chats', connectRules: null });
  });

  it('⭐전부 ON — 세 항목 모두 신 경로, connectRules는 null이 아니다', () => {
    const result = resolveNavV3Destinations({ todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true });
    expect(result.today).toBe('/today');
    expect(result.chats).toBe('/chat');
    expect(result.connectRules).toBe('/connect-rules');
  });
});
