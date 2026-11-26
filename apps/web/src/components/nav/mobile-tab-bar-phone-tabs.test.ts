// story #4885(폰 탭 넷) · 옛 story #4006 AC8 → story 5031 (C1 4단계) — 탭 세트는 플래그 없이 하나(홈 · 채팅 · 에이전트 · 설정 = 웹 아이콘 막대와 같은 1뎁스 넷, 결재 · 일감 · 전체 탭 0)이고,
// 플래그(v3 화면 ON/OFF)는 홈 · 채팅 «목적지»만 정한다(꺼진 v3 화면은 켜지도 떼지도 않는다). 에이전트 · 설정은 그 자리의 첫 화면으로 간다.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHONE_TABS,
  getActiveTabKey,
  resolveTabHref,
} from './mobile-tab-bar';
import { DEPTH1_ITEMS } from '@/lib/nav-depth1';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_OFF: NavV3Flags = DEFAULT_NAV_V3_FLAGS;
const ONLY_TODAY: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false };
const ONLY_CHAT: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false };
const ALL_ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

describe('PHONE_TABS — story 5031 (C1 4단계) 1뎁스 넷(홈 · 채팅 · 에이전트 · 설정)', () => {
  it('키가 정확히 today·chat·agents·settings 4개, 이 순서 — work·more·approvals·now 없음(플래그가 켜져도 탭 세트는 같다)', () => {
    expect(PHONE_TABS.map((t) => t.key)).toEqual(['today', 'chat', 'agents', 'settings']);
  });

  it('탭 넷은 웹 아이콘 막대(DEPTH1_ITEMS)와 같은 자리 · 같은 순서 · 같은 이름 · 같은 첫 화면이다', () => {
    expect(PHONE_TABS.map((t) => t.placeId)).toEqual(DEPTH1_ITEMS.map((d) => d.id));
    expect(PHONE_TABS.map((t) => t.labelKey)).toEqual(DEPTH1_ITEMS.map((d) => d.labelKey));
    expect(PHONE_TABS.map((t) => t.path)).toEqual(DEPTH1_ITEMS.map((d) => d.path));
    expect(PHONE_TABS.map((t) => t.path)).toEqual(['/org-briefing', '/chats', '/organization/workforce', '/settings']);
  });

  it('이름: nav 네임스페이스의 zoneNow(홈) · depth1Chat(채팅) · workforce(에이전트) · settings(설정) — 옛 nav.chats(대화)가 아니다', () => {
    expect(PHONE_TABS.map((t) => [t.namespace, t.labelKey])).toEqual([
      ['nav', 'zoneNow'],
      ['nav', 'depth1Chat'],
      ['nav', 'workforce'],
      ['nav', 'settings'],
    ]);
  });

  it('「홈」 탭 destKey=today · 「채팅」 탭 destKey=chats(플래그가 정하는 목적지) · 「에이전트」「설정」은 destKey 없음(첫 화면 고정)', () => {
    expect(PHONE_TABS.map((t) => t.destKey)).toEqual(['today', 'chats', null, null]);
  });

  it('「일감」「전체」 탭은 없다 — 일감은 채팅 자리의 목록 줄이고 «전체»(/more)는 상단 막대 검색 → ⌘K 「모든 화면」', () => {
    const keys = PHONE_TABS.map((t) => t.key as string);
    expect(keys).not.toContain('work');
    expect(keys).not.toContain('more');
    expect(PHONE_TABS.map((t) => t.href.split('?')[0])).not.toContain('/more');
  });

  it('href 필드는 전부 destHref(...) 파생 — 목적지 문자열 리터럴 직접 박기 0(AC1 동형 규율) · 플래그 OFF 구운 값은 /org-briefing · /chats · /organization/workforce · /settings', () => {
    const source = readFileSync(path.join(__dirname, 'mobile-tab-bar.tsx'), 'utf8');
    const start = source.indexOf('export const PHONE_TABS = DEPTH1_ITEMS.map(');
    const end = source.indexOf('export type TabConfig', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).not.toMatch(/href:\s*'\/[^']*'/);
    expect(block).toMatch(/destHref\(/);
    expect(PHONE_TABS.map((t) => t.href)).toEqual(['/org-briefing', '/chats', '/organization/workforce', '/settings']);
  });
});

describe('getActiveTabKey — 플래그가 정하는 목적지(v3 화면 ON/OFF) + 그 밖은 자리(depth1ForPath)가 정한다', () => {
  it('/today는 today(todayV3Enabled ON)', () => {
    expect(getActiveTabKey('/today', ONLY_TODAY)).toBe('today');
  });

  it('/org-briefing은 today(todayV3Enabled OFF지만 anyV3Enabled — dest.today.path가 /org-briefing으로 해석)', () => {
    expect(getActiveTabKey('/org-briefing', ONLY_CHAT)).toBe('today');
    expect(getActiveTabKey('/org-briefing', ALL_OFF)).toBe('today');
  });

  it('⭐옛 결재 경로(bare /inbox, /gates/*)도 today로 흡수 — 승인 탭 폐지(AC8 핵심). usePathname()은 쿼리 0이라 bare /inbox로 단언(mobile-tab-bar.test.ts 기존 관례와 동형)', () => {
    expect(getActiveTabKey('/inbox', ALL_ON)).toBe('today');
    expect(getActiveTabKey('/gates/abc123', ALL_ON)).toBe('today');
  });

  it('/chat(chatV3Enabled ON)은 chat — 꺼져 있으면 /chat은 셸 밖 화면이라 어느 탭도 안 켠다', () => {
    expect(getActiveTabKey('/chat', ONLY_CHAT)).toBe('chat');
    expect(getActiveTabKey('/chat/thread-1', ONLY_CHAT)).toBe('chat');
    expect(getActiveTabKey('/chat', ALL_OFF)).toBeNull();
  });

  it('일감 목적지(work-list, anyV3Enabled ON)는 이제 «채팅» 자리 — 일감 탭이 아니라 chat이 켜진다(탭 key work는 없다)', () => {
    const dest = resolveNavV3Destinations(ALL_ON);
    expect(dest.work.path).toBe('work-list');
    expect(getActiveTabKey('/qa-org/qa-proj/work-list', ALL_ON)).toBe('chat');
    expect(getActiveTabKey('/qa-org/qa-proj/work-list', ALL_OFF)).toBe('chat');
  });

  it('에이전트 자리: /organization/workforce(+상세)는 agents', () => {
    expect(getActiveTabKey('/organization/workforce', ALL_ON)).toBe('agents');
    expect(getActiveTabKey('/organization/workforce/abc', ALL_ON)).toBe('agents');
  });

  it('설정 자리: /settings · /organization/members · /organization/channels는 settings', () => {
    expect(getActiveTabKey('/settings', ALL_ON)).toBe('settings');
    expect(getActiveTabKey('/organization/members', ALL_ON)).toBe('settings');
    expect(getActiveTabKey('/organization/channels', ALL_ON)).toBe('settings');
  });

  it('홈 자리에 놓인 화면(결과 보드 · 활동 · 루프 큐 · /more)은 today — 예전 «more» 판정이 아니다', () => {
    expect(getActiveTabKey('/organization/insights-board', ALL_ON)).toBe('today');
    expect(getActiveTabKey('/activity', ALL_ON)).toBe('today');
    expect(getActiveTabKey('/loop-queue', ALL_ON)).toBe('today');
  });

  it('셸 밖 화면(/connect-rules · /login)과 모르는 경로는 어느 탭도 안 켠다(null) — 더는 «나머지 전부 more»가 아니다', () => {
    expect(getActiveTabKey('/connect-rules', ALL_ON)).toBeNull();
    expect(getActiveTabKey('/login', ALL_ON)).toBeNull();
    expect(getActiveTabKey('/no-such-screen', ALL_ON)).toBeNull();
  });

  it('플래그 전부 OFF에서도 같은 판정: 보드(flow) = chat · 결재 경로 = 홈(today) — 탭 세트가 플래그로 갈리지 않는다', () => {
    expect(getActiveTabKey('/qa-org/qa-proj/flow', ALL_OFF)).toBe('chat');
    expect(getActiveTabKey('/inbox', ALL_OFF)).toBe('today');
    expect(getActiveTabKey('/org-briefing', ALL_OFF)).toBe('today');
  });
});

describe('resolveTabHref — 홈 · 채팅은 목적지 모듈(플래그)을 반영, 에이전트 · 설정은 첫 화면 고정', () => {
  const tabOf = (key: string) => PHONE_TABS.find((t) => t.key === key)!;
  const same = (h: string) => h;

  it('「홈」 탭 href가 flags에 따라 /today ↔ /org-briefing', () => {
    expect(resolveTabHref(tabOf('today'), resolveNavV3Destinations(ONLY_TODAY), {}, same)).toBe('/today');
    expect(resolveTabHref(tabOf('today'), resolveNavV3Destinations(ONLY_CHAT), {}, same)).toBe('/org-briefing');
  });

  it('「채팅」 탭 href가 flags에 따라 /chat ↔ /chats', () => {
    expect(resolveTabHref(tabOf('chat'), resolveNavV3Destinations(ONLY_CHAT), {}, same)).toBe('/chat');
    expect(resolveTabHref(tabOf('chat'), resolveNavV3Destinations(ONLY_TODAY), {}, same)).toBe('/chats');
    expect(resolveTabHref(tabOf('chat'), resolveNavV3Destinations(ALL_OFF), {}, same)).toBe('/chats');
  });

  // 에이전트 · 설정은 destKey가 없다 — 플래그가 어떻게 켜져도 그 자리의 첫 화면(static)이다. 결과 · 연결 · 규칙은 «전체» 탭이 아니라 ⌘K 「모든 화면」(/more)에서 꺼내진다.
  it('「에이전트」 탭 href는 항상 /organization/workforce · 「설정」 탭은 항상 /settings(flags 무관)', () => {
    for (const flags of [ALL_OFF, ONLY_TODAY, ONLY_CHAT, ALL_ON]) {
      const dest = resolveNavV3Destinations(flags);
      expect(resolveTabHref(tabOf('agents'), dest, {}, same)).toBe('/organization/workforce');
      expect(resolveTabHref(tabOf('settings'), dest, {}, same)).toBe('/settings');
    }
  });

  it('withProject가 static 탭 href를 감싼다(flat 링크 규율: 에이전트 · 설정도 ?p= 유지 경로를 탄다)', () => {
    const wrap = (h: string) => `${h}?p=P1`;
    const dest = resolveNavV3Destinations(ALL_OFF);
    expect(resolveTabHref(tabOf('agents'), dest, {}, wrap)).toBe('/organization/workforce?p=P1');
    expect(resolveTabHref(tabOf('settings'), dest, {}, wrap)).toBe('/settings?p=P1');
  });
});
