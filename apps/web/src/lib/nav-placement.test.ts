// story 5031 (C1) — «빠짐 0»: every screen (page.tsx) has a place in the four-place shell, and every door the table claims is a door that exists.
// Revert-proof: delete a row → ① RED · add a screen without a row → ① RED · claim a door nobody draws (depth1 / cmdk) → ③ ④ RED · name a place that is not one of the four → ② RED.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD_ANCHOR_ITEMS } from '@/components/command-palette/command-palette';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { allNavItems, ALL_SCREENS_ITEM } from './nav-config';
import { DEPTH1_IDS, DEPTH1_ITEMS, depth1ByShortcut, depth1ForPath, placementSlotForPath } from './nav-depth1';
import { ROUTE_PLACEMENT, type PlacementDoor } from './nav-placement';

const APP_DIR = join(__dirname, '..', 'app');

function pageRoutes(dir: string, out: Array<{ route: string; file: string }> = []): Array<{ route: string; file: string }> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { pageRoutes(full, out); continue; }
    if (name !== 'page.tsx') continue;
    const segs = relative(APP_DIR, dir).split(sep).filter((s) => s && !/^\(.+\)$/.test(s));
    out.push({ route: '/' + segs.join('/'), file: full });
  }
  return out;
}

const pages = pageRoutes(APP_DIR);
const routes = pages.map((p) => p.route);
const rows = Object.entries(ROUTE_PLACEMENT);

// the catalog doors, computed the way the shell computes them
const catalogRoute = (item: { kind: string; path: string }) => (item.kind === 'resource' ? `/[ws]/[proj]/${item.path.split('?')[0]}` : item.path.split('?')[0]!);
const catalog = allNavItems();
const paletteRoutes = new Set<string>([
  ...catalog.map(catalogRoute),
  ...WORKSPACE_FRAME_TAB_PATHS.map((p) => `/[ws]/[proj]/${p}`),
  ...GUARD_ANCHOR_ITEMS.map((a) => `/[ws]/[proj]/${a.href.replace(/^\//, '')}`),
  ALL_SCREENS_ITEM.path,
]);
const catalogRoutes = new Set(catalog.map(catalogRoute));

describe('⭐ ① 모든 화면이 한 줄씩(빠짐 0 · 남는 줄 0)', () => {
  it('디스크의 page.tsx 집합 = 표의 키 집합(87쪽)', () => {
    expect([...routes].sort()).toEqual(Object.keys(ROUTE_PLACEMENT).sort());
    expect(routes).toHaveLength(87);
  });
});

describe('⭐ ② 자리는 넷(홈 · 채팅 · 에이전트 · 설정) 아니면 «셸 밖»', () => {
  it('모든 줄의 자리가 그 다섯 중 하나다', () => {
    const allowed = new Set<string>([...DEPTH1_IDS, 'outside']);
    expect(rows.filter(([, r]) => !allowed.has(r.slot)).map(([route]) => route)).toEqual([]);
  });

  it('1뎁스는 정확히 넷 · 순서 홈 → 채팅 → 에이전트 → 설정 · 이름 · 단축키 ⌘1~4 (되돌리면 RED)', () => {
    expect(DEPTH1_IDS).toEqual(['home', 'chat', 'agents', 'settings']);
    expect(DEPTH1_ITEMS.map((i) => i.id)).toEqual(['home', 'chat', 'agents', 'settings']);
    expect(DEPTH1_ITEMS.map((i) => i.shortcut)).toEqual(['1', '2', '3', '4']);
    for (const [lang, m] of [['ko', koMessages], ['en', enMessages]] as const) {
      const nav = m.nav as Record<string, string>;
      expect(DEPTH1_ITEMS.map((i) => nav[i.labelKey]), lang).toEqual(lang === 'ko' ? ['홈', '채팅', '에이전트', '설정'] : ['Home', 'Chat', 'Agents', 'Settings']);
    }
    expect(depth1ByShortcut('3')?.id).toBe('agents');
    expect(depth1ByShortcut('5')).toBeUndefined();
  });

  it('네 자리의 첫 화면은 실제 화면이고 그 자리에 속한다', () => {
    for (const item of DEPTH1_ITEMS) {
      expect(routes, item.path).toContain(item.path);
      expect(ROUTE_PLACEMENT[item.path]!.slot, item.path).toBe(item.id);
    }
  });

  it('PO 판정(11-26) 줄들: 사람 명단 = 설정 · 에이전트 목록 = 에이전트 · 결과 = 홈 · 신뢰 · 보상 = 에이전트 · 목표 · 스토리지 = 채팅 · 꺼진 v3 시안 = 셸 밖', () => {
    const slot = (r: string) => ROUTE_PLACEMENT[r]!.slot;
    expect(slot('/organization/members')).toBe('settings');
    expect(slot('/organization/roles')).toBe('settings');
    expect(slot('/organization/workforce')).toBe('agents');
    expect(slot('/organization/insights-board')).toBe('home');
    expect(slot('/organization/trust')).toBe('agents');
    expect(slot('/rewards')).toBe('agents');
    expect(slot('/[ws]/[proj]/goals')).toBe('chat');
    expect(slot('/[ws]/[proj]/storage')).toBe('chat');
    for (const r of ['/today', '/chat', '/connect-rules']) { expect(slot(r), r).toBe('outside'); expect(ROUTE_PLACEMENT[r]!.why, r).not.toMatch(/제거 후보/); }
    expect(ROUTE_PLACEMENT['/today']!.why).toContain('/org-briefing');
    expect(ROUTE_PLACEMENT['/chat']!.why).toContain('/chats');
    for (const r of ['/design-system', '/docs/design-tokens', '/internal-dogfood', '/mfa', '/auth/reset-required']) expect(slot(r), r).toBe('outside');
    for (const r of ['/organization/connectors', '/dashboard', '/dashboard/settings']) { expect(slot(r), r).toBe('outside'); expect(ROUTE_PLACEMENT[r]!.doors, r).toEqual(['redirect']); }
    expect(ROUTE_PLACEMENT['/organization/memory']!.doors).toEqual(['none']);
    expect(ROUTE_PLACEMENT['/loop-queue']).toMatchObject({ slot: 'home', doors: ['cmdk'] });
  });
});

describe('⭐ ③ 줄이 말한 입구는 실제로 있다', () => {
  const hasDoor = (door: PlacementDoor) => rows.filter(([, r]) => r.doors.includes(door)).map(([route]) => route);

  it('모든 줄에 입구가 하나 이상(«없음»은 이유가 적힌 줄만)', () => {
    expect(rows.filter(([, r]) => r.doors.length === 0).map(([route]) => route)).toEqual([]);
    for (const [route, r] of rows) {
      expect(r.why.trim().length, `${route} why`).toBeGreaterThan(3);
      if (r.doors.includes('none')) expect(r.doors, `${route}: «없음»은 다른 입구와 같이 못 씀`).toEqual(['none']);
    }
  });

  it('depth1 = 목록 칸에 줄이 그려지는 카탈로그 항목이다 / cmdk = ⌘K에 실리는 경로다', () => {
    for (const route of hasDoor('depth1')) expect(catalogRoutes.has(route), `${route}가 카탈로그 항목이 아님`).toBe(true);
    for (const route of hasDoor('cmdk')) expect(paletteRoutes.has(route), `${route}가 ⌘K에 안 실림`).toBe(true);
  });

  it('거꾸로: ⌘K에 실리는 경로는 표가 cmdk로 적고, 목록 칸 줄이 될 카탈로그 항목은 표가 depth1로 적는다(표와 화면이 같은 말)', () => {
    for (const route of paletteRoutes) {
      if (route === '/desktop') continue; // 서버 호스트 · 데스크톱 받기 플래그가 켜진 곳에서만 실림 — 표는 cmdk로 적는다
      expect(ROUTE_PLACEMENT[route]?.doors, `${route} 표에 cmdk 없음`).toContain('cmdk');
    }
    const paletteOnly = new Set(['/loop-queue']);
    for (const route of catalogRoutes) {
      if (paletteOnly.has(route) || route === ALL_SCREENS_ITEM.path) continue;
      expect(ROUTE_PLACEMENT[route]?.doors, `${route} 표에 depth1 없음`).toContain('depth1');
    }
  });

  it('in-page = 부모 줄(from)이 표에 있고, 부모 사슬이 끝내 실제 입구(depth1 · cmdk · flow)에 닿는다 · 같은 자리', () => {
    for (const [route, r] of rows.filter(([, row]) => row.doors.includes('in-page'))) {
      let at = route;
      const seen = new Set<string>();
      let cur = ROUTE_PLACEMENT[at]!;
      while (cur.doors.includes('in-page') && !cur.doors.includes('cmdk') && !cur.doors.includes('depth1')) {
        expect(cur.from, `${at}: from 없음`).toBeTruthy();
        expect(seen.has(at), `${route}: 부모 사슬이 돈다`).toBe(false);
        seen.add(at);
        at = cur.from!;
        expect(ROUTE_PLACEMENT[at], `${route}: 부모 ${at}가 표에 없음`).toBeTruthy();
        cur = ROUTE_PLACEMENT[at]!;
      }
      expect(r.from, `${route}: from`).toBeTruthy();
      expect(ROUTE_PLACEMENT[r.from!]!.slot, `${route}: 부모와 같은 자리`).toBe(r.slot);
    }
  });

  it('redirect = 그 쪽 소스가 실제로 다른 곳으로 보낸다', () => {
    for (const route of hasDoor('redirect')) {
      const file = pages.find((p) => p.route === route)!.file;
      expect(existsSync(file), route).toBe(true);
      expect(readFileSync(file, 'utf8'), `${route}가 redirect를 안 함`).toMatch(/redirect\(|permanentRedirect\(/);
    }
  });
});

describe('⭐ ④ 길 → 자리 판정(depth1ForPath) — 막대에서 «지금 여기»를 켜는 함수', () => {
  it.each([
    ['/org-briefing', 'home'], ['/inbox', 'home'], ['/gates/abc', 'home'], ['/organization/insights-board', 'home'], ['/loop-queue', 'home'],
    ['/chats', 'chat'], ['/chats/3f2', 'chat'], ['/content/channel-posts/calendar', 'chat'], ['/content/channel-posts/abc', 'chat'], ['/acme/web/flow', 'chat'], ['/acme/web/docs/some-slug/view', 'chat'], ['/acme/web/goals/9', 'chat'],
    ['/organization/workforce', 'agents'], ['/organization/workforce/runs', 'agents'], ['/organization/workforce/abc', 'agents'], ['/organization/trust', 'agents'], ['/rewards', 'agents'],
    ['/settings', 'settings'], ['/settings/integrations', 'settings'], ['/organization/members', 'settings'], ['/organization/channels', 'settings'], ['/desktop', 'settings'], ['/desktop/pair', 'settings'],
  ] as const)('%s → %s', (path, want) => {
    expect(depth1ForPath(path)).toBe(want);
    expect(depth1ForPath(`${path}?p=1#x`)).toBe(want);
  });
  it('셸 밖 · 모르는 길은 아무 자리도 켜지 않는다', () => {
    expect(depth1ForPath('/login')).toBeUndefined();
    expect(depth1ForPath('/today')).toBeUndefined();
    expect(placementSlotForPath('/today')).toBe('outside');
    expect(depth1ForPath('/no/such/screen/at/all')).toBeUndefined();
    expect(placementSlotForPath('/no/such/screen/at/all')).toBeUndefined();
  });
});
