// story #4885(폰 탭 넷) · 옛 story #4006 AC8 — 탭 세트는 플래그 없이 하나(홈 · 대화 · 일감 · 전체, 결재 탭 0)이고, 플래그(v3 화면 ON/OFF)는 «목적지»만 정한다(꺼진 v3 화면은 켜지도 떼지도 않는다).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHONE_TABS,
  getActiveTabKey,
  resolveTabHref,
} from './mobile-tab-bar';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_OFF: NavV3Flags = DEFAULT_NAV_V3_FLAGS;
const ONLY_TODAY: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false };
const ONLY_CHAT: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false };
const ALL_ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

describe('PHONE_TABS — 4탭 구성(홈 · 대화 · 일감 · 전체, 결재 탭 0)', () => {
  it('키가 정확히 today·chat·work·more 4개, approvals·now 없음 — 플래그가 켜져도 탭 세트는 같다(목적지만 다르다)', () => {
    expect(PHONE_TABS.map((t) => t.key)).toEqual(['today', 'chat', 'work', 'more']);
  });

  it('「홈」 탭 destKey=today, labelKey=zoneNow(사이드바 「홈」과 같은 낱말)', () => {
    const today = PHONE_TABS.find((t) => t.key === 'today')!;
    expect(today.destKey).toBe('today');
    expect(today.labelKey).toBe('zoneNow');
    expect(today.namespace).toBe('nav');
  });

  it('「일감」 탭 destKey=work', () => {
    expect(PHONE_TABS.find((t) => t.key === 'work')!.destKey).toBe('work');
  });

  it('href 필드는 전부 destHref(...) 파생 — 목적지 문자열 리터럴 직접 박기 0(AC1 동형 규율)', () => {
    const source = readFileSync(path.join(__dirname, 'mobile-tab-bar.tsx'), 'utf8');
    const start = source.indexOf('export const PHONE_TABS = [');
    const end = source.indexOf('] as const;', start);
    const block = source.slice(start, end);
    expect(block).not.toMatch(/href:\s*'\/[^']*'/);
  });
});

describe('getActiveTabKey — 플래그가 정하는 목적지(v3 화면 ON/OFF)', () => {
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

  it('플래그 전부 OFF에서도 같은 4탭 판정: 일감 = work · 결재 경로 = 홈(today) — 탭 세트가 플래그로 갈리지 않는다', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/flow', ALL_OFF)).toBe('work');
    expect(getActiveTabKey('/inbox', ALL_OFF)).toBe('today');
    expect(getActiveTabKey('/org-briefing', ALL_OFF)).toBe('today');
  });
});

describe('resolveTabHref — 탭은 목적지 모듈(플래그)을 그대로 반영', () => {
  it('「오늘」 탭 href가 flags에 따라 /today ↔ /org-briefing', () => {
    const todayTab = PHONE_TABS.find((t) => t.key === 'today')!;
    expect(resolveTabHref(todayTab, resolveNavV3Destinations(ONLY_TODAY), {}, (h) => h)).toBe('/today');
    expect(resolveTabHref(todayTab, resolveNavV3Destinations(ONLY_CHAT), {}, (h) => h)).toBe('/org-briefing');
  });

  it('「일감」 탭 href가 anyV3Enabled에 따라 work-list ↔ flow(bare, resource kind)', () => {
    const workTab = PHONE_TABS.find((t) => t.key === 'work')!;
    expect(resolveTabHref(workTab, resolveNavV3Destinations(ALL_ON), {}, (h) => h)).toBe('/work-list');
  });

  // story #4006 AC8 PO CHANGES-1 follow-up(2026-09-22) — v3 4탭(오늘/대화/일감/더보기)엔
  // 「결과」·「연결·규칙」 전용 슬롯이 없다. 그 둘이 조용히 사라지지 않고 「더보기」 탭
  // 뒤(/more)에서 실제로 꺼내진다는 것을 두 파일 경계에 걸쳐 핀 — href 축은 여기서,
  // /more가 실제로 그 두 섹션을 렌더하는지는 app/(authenticated)/more/page.test.tsx의
  // 「섹션(h2) 순서가 확定대로다(오늘/결과/연결·규칙/...)」(기존, NAV_GROUPS SSOT 소비라
  // v3 플래그와 무관하게 항상 참)가 이미 고정 — 두 핀이 합쳐야 AC8의 "두 진입점"이 성립.
  it('「더보기」 탭 href는 항상 /more(flags 무관) — 결과·연결·규칙은 이 안에서 나온다', () => {
    const moreTab = PHONE_TABS.find((t) => t.key === 'more')!;
    expect(resolveTabHref(moreTab, resolveNavV3Destinations(ALL_ON), {}, (h) => h)).toBe('/more');
    expect(resolveTabHref(moreTab, resolveNavV3Destinations(ONLY_TODAY), {}, (h) => h)).toBe('/more');
  });
});
