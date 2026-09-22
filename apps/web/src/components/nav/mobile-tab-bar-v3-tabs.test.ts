// story #4006(critical, 5pt) AC8(§2, doc 5bc82986-6617-4e5a-9f4d-aef29e2201f9) —
// v3 플래그 중 하나라도 ON이면 하단 탭이 오늘·대화·일감·더보기 4탭으로 바뀐다
// (「승인」 탭 폐지, 「오늘」로 흡수). 플래그 전부 OFF는 기존 TABS 그대로(바이트
// 무변 — mobile-tab-bar.test.ts가 이미 그 축을 지킨다, 이 파일은 v3 축만).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  V3_TABS,
  TABS,
  resolveTabsForFlags,
  getActiveTabKey,
  resolveTabHref,
} from './mobile-tab-bar';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_OFF: NavV3Flags = DEFAULT_NAV_V3_FLAGS;
const ONLY_TODAY: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false };
const ONLY_CHAT: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false };
const ONLY_CONNECT_RULES: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true };
const ALL_ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

describe('resolveTabsForFlags — story #4006 AC8', () => {
  it('전부 OFF면 기존 TABS(바이트 동일 참조)', () => {
    expect(resolveTabsForFlags(ALL_OFF)).toBe(TABS);
  });

  it.each([
    ['todayV3Enabled만', ONLY_TODAY],
    ['chatV3Enabled만', ONLY_CHAT],
    ['connectRulesV3Enabled만', ONLY_CONNECT_RULES],
    ['전부 ON', ALL_ON],
  ])('%s ON이면 V3_TABS(하나라도 ON=anyV3Enabled 신호, nav-v3-destinations.ts work축과 동형)', (_label, flags) => {
    expect(resolveTabsForFlags(flags)).toBe(V3_TABS);
  });
});

describe('V3_TABS — 4탭 구성(오늘·대화·일감·더보기, 승인 탭 0)', () => {
  it('키가 정확히 today·chat·work·more 4개, approvals·now 없음', () => {
    expect(V3_TABS.map((t) => t.key)).toEqual(['today', 'chat', 'work', 'more']);
  });

  it('「오늘」 탭 destKey=today, labelKey=zoneNow(레거시 사이드바 「오늘」과 같은 낱말)', () => {
    const today = V3_TABS.find((t) => t.key === 'today')!;
    expect(today.destKey).toBe('today');
    expect(today.labelKey).toBe('zoneNow');
    expect(today.namespace).toBe('nav');
  });

  it('「일감」 탭 destKey=work(레거시 now 탭과 같은 목적지 축, key만 다름)', () => {
    const work = V3_TABS.find((t) => t.key === 'work')!;
    expect(work.destKey).toBe('work');
  });

  it('href 필드는 전부 destHref(...) 파생 — 목적지 문자열 리터럴 직접 박기 0(AC1 동형 규율)', () => {
    // TABS의 no-literal-destination 가드(#4016 AC1)와 같은 정신 — V3_TABS도 리터럴 href 금지.
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'mobile-tab-bar.tsx'),
      'utf8',
    ) as string;
    const start = source.indexOf('export const V3_TABS = [');
    const end = source.indexOf('] as const;', start);
    const block = source.slice(start, end);
    expect(block).not.toMatch(/href:\s*'\/[^']*'/);
  });
});

describe('getActiveTabKey — v3 分岐(AC8)', () => {
  it('/today는 today(todayV3Enabled ON)', () => {
    expect(getActiveTabKey('/today', ONLY_TODAY)).toBe('today');
  });

  it('/org-briefing은 today(todayV3Enabled OFF지만 anyV3Enabled — dest.today.path가 /org-briefing으로 해석)', () => {
    expect(getActiveTabKey('/org-briefing', ONLY_CHAT)).toBe('today');
  });

  it('⭐옛 결재 경로(bare /inbox, /gates/*)도 today로 흡수 — 승인 탭 폐지(AC8 핵심). usePathname()은 쿼리 0이라 bare /inbox로 단언(mobile-tab-bar.test.ts 기존 관례와 동형)', () => {
    expect(getActiveTabKey('/inbox', ALL_ON)).toBe('today');
    expect(getActiveTabKey('/gates/abc123', ALL_ON)).toBe('today');
  });

  it('/chat(chatV3Enabled ON)은 chat', () => {
    expect(getActiveTabKey('/chat', ONLY_CHAT)).toBe('chat');
    expect(getActiveTabKey('/chat/thread-1', ONLY_CHAT)).toBe('chat');
  });

  it('일감 목적지(work-list, anyV3Enabled ON)는 work — 레거시 now와 다른 key', () => {
    const dest = resolveNavV3Destinations(ALL_ON);
    expect(dest.work.path).toBe('work-list');
    expect(getActiveTabKey('/qa-org/qa-proj/work-list', ALL_ON)).toBe('work');
  });

  it('나머지 전부 more(연결·규칙·결과 등 4탭 밖 경로)', () => {
    expect(getActiveTabKey('/connect-rules', ALL_ON)).toBe('more');
    expect(getActiveTabKey('/organization/insights-board', ALL_ON)).toBe('more');
  });

  it('플래그 전부 OFF면 기존 판정 그대로(now/approvals, 바이트 무변 — 회귀 0)', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/flow', ALL_OFF)).toBe('now');
    expect(getActiveTabKey('/inbox', ALL_OFF)).toBe('approvals');
  });
});

describe('resolveTabHref — V3_TABS 탭도 목적지 모듈 그대로 반영', () => {
  it('「오늘」 탭 href가 flags에 따라 /today ↔ /org-briefing', () => {
    const todayTab = V3_TABS.find((t) => t.key === 'today')!;
    expect(resolveTabHref(todayTab, resolveNavV3Destinations(ONLY_TODAY))).toBe('/today');
    expect(resolveTabHref(todayTab, resolveNavV3Destinations(ONLY_CHAT))).toBe('/org-briefing');
  });

  it('「일감」 탭 href가 anyV3Enabled에 따라 work-list ↔ flow(bare, resource kind)', () => {
    const workTab = V3_TABS.find((t) => t.key === 'work')!;
    expect(resolveTabHref(workTab, resolveNavV3Destinations(ALL_ON))).toBe('/work-list');
  });
});
