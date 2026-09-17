import { describe, expect, it } from 'vitest';
import {
  resolveNavV3Destinations,
  resolveChatsHref,
  resolveConnectRulesHref,
  type NavV3Destination,
  type NavV3Flags,
} from './nav-v3-destinations';

// story #4003 AC1/AC3(CHANGES, PR#4386 1차 리뷰) — 플래그 3개(2^3=8조합) × 항목
// 5개(오늘·대화·일감·결과·연결·규칙) 표. work/results도 서술자로 이 모듈이 정한다
// (호출부 접두 로직 복붙 없이, kind로만 구분).
// story #4016(페드루 PO 確定 2026-09-17) — 결재·전체 2항목 추가(모바일 탭 바 전용,
// results와 동형인 플래그-무관 고정 경로 — AC1 「파일 안 경로 리터럴 0」이 탭 바
// 소비처에서 성립하려면 이 모듈에 있어야 한다).
const STATIC = (path: string): NavV3Destination => ({ kind: 'static', path });
const RESOURCE = (path: string): NavV3Destination => ({ kind: 'resource', path });
const APPROVALS = STATIC('/inbox?tab=gates');
const MORE = STATIC('/more');

const COMBOS: Array<{
  flags: NavV3Flags;
  today: NavV3Destination;
  chats: NavV3Destination;
  work: NavV3Destination;
  results: NavV3Destination;
  connectRules: NavV3Destination | null;
}> = [
  { flags: { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false }, today: STATIC('/org-briefing'), chats: STATIC('/chats'), work: RESOURCE('flow'), results: STATIC('/organization/insights-board'), connectRules: null },
  { flags: { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false }, today: STATIC('/today'), chats: STATIC('/chats'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: null },
  { flags: { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false }, today: STATIC('/org-briefing'), chats: STATIC('/chat'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: null },
  { flags: { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true }, today: STATIC('/org-briefing'), chats: STATIC('/chats'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: STATIC('/connect-rules') },
  { flags: { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: false }, today: STATIC('/today'), chats: STATIC('/chat'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: null },
  { flags: { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: true }, today: STATIC('/today'), chats: STATIC('/chats'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: STATIC('/connect-rules') },
  { flags: { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: true }, today: STATIC('/org-briefing'), chats: STATIC('/chat'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: STATIC('/connect-rules') },
  { flags: { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true }, today: STATIC('/today'), chats: STATIC('/chat'), work: RESOURCE('work-list'), results: STATIC('/organization/insights-board'), connectRules: STATIC('/connect-rules') },
];

describe('resolveNavV3Destinations — 플래그 8조합 × 항목 5개 표(story #4003 AC1/AC3)', () => {
  it.each(COMBOS)('$flags', ({ flags, today, chats, work, results, connectRules }) => {
    const result = resolveNavV3Destinations(flags);
    expect(result).toEqual({ today, chats, work, results, connectRules, approvals: APPROVALS, more: MORE });
  });

  it('⭐전부 OFF — 지금 develop과 바이트 동일(회귀 0 기준선) — 「일감」도 포함', () => {
    const result = resolveNavV3Destinations({ todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false });
    expect(result.work).toEqual({ kind: 'resource', path: 'flow' });
  });

  it('⭐「일감」은 어느 한 플래그라도 ON이면 work-list — 단일 플래그 의존이 아니다', () => {
    expect(resolveNavV3Destinations({ todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false }).work.path).toBe('work-list');
    expect(resolveNavV3Destinations({ todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false }).work.path).toBe('work-list');
    expect(resolveNavV3Destinations({ todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true }).work.path).toBe('work-list');
  });

  it('「결과」는 플래그 8조합 전부에서 고정(분기 자체가 없음)', () => {
    for (const { flags } of COMBOS) {
      expect(resolveNavV3Destinations(flags).results).toEqual({ kind: 'static', path: '/organization/insights-board' });
    }
  });

  // story #4016 — 「결재」·「전체」도 결과와 동형으로 플래그 8조합 전부에서 고정.
  it('「결재」·「전체」도 플래그 8조합 전부에서 고정(분기 자체가 없음)', () => {
    for (const { flags } of COMBOS) {
      const result = resolveNavV3Destinations(flags);
      expect(result.approvals).toEqual(APPROVALS);
      expect(result.more).toEqual(MORE);
    }
  });
});

// story #4017(PO 확定 2026-09-17) AC3 — 본문 CTA·session-redirect.ts가 쓰는 얇은 헬퍼의
// 실 로직. dashboard-shell.tsx의 useChatsHref/useConnectRulesHref는 이 함수에
// useDashboardContext().navV3Flags만 얹는 래퍼라, 무거운 React/DashboardShell 의존 없이
// 여기서 OFF/ON 양쪽 + 양성 대조를 고정한다.
describe('resolveChatsHref — story #4017 AC3', () => {
  it('⭐flags undefined(컨텍스트 미배선) — 레거시 /chats', () => {
    expect(resolveChatsHref(undefined)).toBe('/chats');
  });

  it('⭐chatV3Enabled=false — /chats(OFF 바이트 동일)', () => {
    expect(resolveChatsHref({ todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false })).toBe('/chats');
  });

  it('⭐chatV3Enabled=true — /chat(다른 플래그 무관)', () => {
    expect(resolveChatsHref({ todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false })).toBe('/chat');
    expect(resolveChatsHref({ todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true })).toBe('/chat');
  });

  it('양성 대조 — resolveNavV3Destinations를 안 거치고 직접 반환하면(예: 항상 /chats) 위 ON 시험이 RED', () => {
    // resolveChatsHref가 실제로 resolveNavV3Destinations(flags).chats.path를 위임하는지
    // 확認 — 8조합 표(COMBOS)의 chats 값과 1:1 대조.
    for (const { flags, chats } of COMBOS) {
      expect(resolveChatsHref(flags)).toBe(chats.path);
    }
  });
});

describe('resolveConnectRulesHref — story #4017 AC3', () => {
  it('⭐flags undefined — legacyFallback 그대로', () => {
    expect(resolveConnectRulesHref(undefined, '/organization/channels')).toBe('/organization/channels');
    expect(resolveConnectRulesHref(undefined, '/organization/content-rules')).toBe('/organization/content-rules');
  });

  it('⭐connectRulesV3Enabled=false — legacyFallback 그대로(자리마다 다른 값)', () => {
    const flags: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false };
    expect(resolveConnectRulesHref(flags, '/organization/channels')).toBe('/organization/channels');
    expect(resolveConnectRulesHref(flags, '/organization/content-rules')).toBe('/organization/content-rules');
  });

  it('⭐connectRulesV3Enabled=true — legacyFallback 무관하게 항상 /connect-rules(통합 화면)', () => {
    const flags: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true };
    expect(resolveConnectRulesHref(flags, '/organization/channels')).toBe('/connect-rules');
    expect(resolveConnectRulesHref(flags, '/organization/content-rules')).toBe('/connect-rules');
  });
});
