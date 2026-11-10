// story #4885(UI-2 AC4 PR 1) — 모바일 «전체» 구역을 실 nav-config로 돈다. 구역 = 사이드바와 같은 한 정의(NAV_GROUPS) 그대로 + 맨 아래 «그 밖의 화면»(OTHER_NAV_ITEMS).
// 빼는 항목은 탭바가 실제로 그리는 탭의 목적지 · 탭에 없는 목적지는 메뉴에 반드시. (story #4278의 «연결·규칙 소묶음 합치기» · 「더보기」 소묶음은 서랍이 걷히며 사라졌다.)
// 뮤테이션: ① 제외를 빼면 탭 목적지가 메뉴에 또 나온다 ② 구역 순서 목록에서 구역을 빼면 그 구역 항목이 «도달불가»가 된다 ③ 그 밖 카드를 빼면 그 밖 화면이 사라진다.
import { describe, expect, it } from 'vitest';
import { MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS, OTHER_NAV_ITEMS, resolveNavGroups } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { tabDestinationNavIds } from '@/components/nav/mobile-tab-bar';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { buildMobileHubGroups, MOBILE_OTHER_CARD_ID, sectionHeader } from './mobile-hub-groups';

const ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

function hub(flags: NavV3Flags) {
  return buildMobileHubGroups({
    groups: resolveNavGroups(flags),
    groupOrder: MOBILE_HUB_GROUP_ORDER,
    otherItems: OTHER_NAV_ITEMS,
    excludeIds: tabDestinationNavIds(flags),
  });
}
const ids = (g: ReturnType<typeof hub>[number] | undefined) => (g?.items ?? []).map((i) => i.id);

describe('buildMobileHubGroups(story #4885)', () => {
  it('⭐구역 순서(폰 탭 넷): 탭에 없는 매일 구역 팀 · 지식이 맨 위 두 구역 → 설정 → 홈 · 일감 쪽 남은 항목 → 조직 → 맨 아래 «그 밖의 화면» 카드', () => {
    const g = hub(DEFAULT_NAV_V3_FLAGS);
    expect(g.map((x) => x.id)).toEqual(['team', 'knowledge', 'settings', 'now', 'dev', 'org', MOBILE_OTHER_CARD_ID]);
    // 구역 종류는 사이드바와 같은 한 정의(NAV_GROUPS) — 순서만 다르다(사이드바에는 탭이 없어 홈 · 일감이 위)
    expect([...MOBILE_HUB_GROUP_ORDER].sort()).toEqual(NAV_GROUPS.map((x) => x.id).sort());
    expect(g[g.length - 1]).toMatchObject({ id: MOBILE_OTHER_CARD_ID, labelKey: 'moreOtherScreens' });
    expect(ids(g[g.length - 1])).toEqual(OTHER_NAV_ITEMS.map((i) => i.id));
  });

  it('⭐탭 목적지만 뺀다 — 홈 · 대화 · 일감(플래그와 무관): 홈 · 보드 빠짐 · «결재 탭»은 없어 결재(inbox)는 메뉴에 남는다', () => {
    expect(tabDestinationNavIds(DEFAULT_NAV_V3_FLAGS)).toEqual(new Set(['org-briefing', 'chats', 'board']));
    const g = hub(DEFAULT_NAV_V3_FLAGS);
    const all = g.flatMap(ids);
    expect(all).not.toContain('board');
    expect(all).not.toContain('org-briefing');
    expect(ids(g.find((x) => x.id === 'now'))).toEqual(['inbox']);
  });

  it('탭 세트는 플래그로 갈리지 않는다 — 켜져도(ON) 같은 세 목적지를 빼고 결재가 «홈» 구역 자리에 남는다', () => {
    expect(tabDestinationNavIds(ON)).toEqual(new Set(['org-briefing', 'chats', 'board']));
    const g = hub(ON);
    expect(ids(g.find((x) => x.id === 'now'))).toEqual(['inbox']);
    expect(g.flatMap(ids)).not.toContain('org-briefing');
  });

  it('⭐서랍이 걷혔다 — 예전 소묶음(subgroups)도 «연결·규칙» 구역도 없다 · «팀» 한 구역에 구성원 · 에이전트 · 실행 기록 · API 키', () => {
    const g = hub(DEFAULT_NAV_V3_FLAGS);
    expect(g.every((x) => !('subgroups' in x))).toBe(true);
    expect(g.map((x) => x.id)).not.toContain('connect-rules');
    expect(ids(g.find((x) => x.id === 'team'))).toEqual(['org-members', 'org-workforce', 'org-workforce-runs', 'org-workforce-api-keys']);
  });

  it('⭐MOBILE_HUB_EXCLUDE_IDS(깊이 가드가 «탭 직행 1회»로 세는 항목)는 폰 하단 탭이 실제로 덮는 목적지와 같다 — 집합이 어긋나면 가드가 탭 직행 항목을 허브 2탭으로(또는 허브 항목을 1탭으로) 세어 거짓이 된다(codex 단서 ②)', () => {
    expect([...MOBILE_HUB_EXCLUDE_IDS].sort()).toEqual([...tabDestinationNavIds(DEFAULT_NAV_V3_FLAGS)].sort());
    expect([...MOBILE_HUB_EXCLUDE_IDS].sort()).toEqual(['board', 'chats', 'org-briefing']);
  });

  it('모든 목적지는 탭이나 메뉴 어딘가에 — 플래그 둘 다(NAV_GROUPS 전부 + 그 밖 전부)', () => {
    for (const flags of [DEFAULT_NAV_V3_FLAGS, ON]) {
      const inMenu = new Set(hub(flags).flatMap(ids));
      const inTabs = tabDestinationNavIds(flags);
      const everything = [...resolveNavGroups(flags).flatMap((g) => g.items.map((i) => i.id)), ...OTHER_NAV_ITEMS.map((i) => i.id)];
      const lost = everything.filter((id) => !inMenu.has(id) && !inTabs.has(id));
      expect(lost, JSON.stringify(flags)).toEqual([]);
    }
  });

  it('구역 순서 목록에 없는 구역은 허브에 안 뜬다(그래서 mobile depth 가드가 «도달불가»로 잡는다)', () => {
    const g = buildMobileHubGroups({ groups: resolveNavGroups(DEFAULT_NAV_V3_FLAGS), groupOrder: ['now'], otherItems: [], excludeIds: new Set() });
    expect(g.map((x) => x.id)).toEqual(['now']);
  });
});

// story #4292(유나 1안 확정) — 판정 한 조건: 보이는 항목 1 ∧ 그 이름 = 머리(**번역된 글자로** · 까디르 QA ①) → 머리 없음. 이름이 다르면
// 머리 유지 · 여러 항목이면 머리 유지. ko · en 두 로케일 모두.
// 뮤테이션: 늘 머리를 돌려주면(예전 동작) 첫 줄들이 RED · 한 항목이면 늘 null이면 «이름 다른 한 항목» 줄이 RED · 키로 비교하면 «다른 키 같은 글자» 줄이 RED.
const translator = (messages: { nav: Record<string, string> }) => (key: string) => messages.nav[key] ?? key;
const LOCALES = [['ko', translator(koMessages)], ['en', translator(enMessages)]] as const;

describe.each(LOCALES)('sectionHeader(story #4292) — %s', (_locale, t) => {
  const byId = (flags: NavV3Flags, id: string) => hub(flags).find((x) => x.id === id)!;

  it('⭐«홈» 구역은 홈이 하단 탭으로 빠져 결재 하나만 남는다(머리 없는 한 항목 구역) — 머리 없음 · 이름은 그대로(접근 이름)', () => {
    const now = byId(DEFAULT_NAV_V3_FLAGS, 'now');
    expect(ids(now)).toEqual(['inbox']);
    expect(sectionHeader(now, t)).toEqual({ headerKey: null, name: t('approvals') });
  });

  it('⭐«설정»(머리 없는 한 항목 구역) — 예전엔 항목 이름을 머리로 끌어와 «설정 › 설정», 이제 머리 없음', () => {
    const settings = byId(ON, 'settings');
    expect(settings.labelKey).toBeUndefined();
    expect(sectionHeader(settings, t)).toEqual({ headerKey: null, name: t('settings') });
  });

  it('검색으로 한 항목만 남아 그 이름이 머리와 같아도 — 머리 없음(거른 뒤에도 같은 함수)', () => {
    const now = byId(DEFAULT_NAV_V3_FLAGS, 'now');
    expect(sectionHeader({ ...now, items: now.items.filter((i) => i.labelKey === 'approvals') }, t).headerKey).toBeNull();
  });

  it('남은 한 항목 이름이 머리와 다르면 머리 유지 — «지식 › 문서» · 검색으로 한 항목만 남아도', () => {
    const knowledge = byId(DEFAULT_NAV_V3_FLAGS, 'knowledge');
    expect(sectionHeader({ ...knowledge, items: knowledge.items.slice(0, 1) }, t).headerKey).toBe('zoneKnowledge');
  });

  it('여러 항목 구역은 머리 그대로', () => {
    for (const flags of [DEFAULT_NAV_V3_FLAGS, ON]) {
      for (const group of hub(flags).filter((x) => x.items.length > 1)) {
        expect(sectionHeader(group, t).headerKey).toBe(group.labelKey ?? group.items[0]!.labelKey);
      }
    }
  });
});

it('⭐키가 달라도 번역된 글자가 같으면 같은 낱말로 본다(까디르 QA ① — 규칙의 뜻은 «화면에 같은 글자 두 번»)', () => {
  const group = { labelKey: 'zoneA', items: [{ labelKey: 'itemB' }] } as unknown as Parameters<typeof sectionHeader>[0];
  const same = (k: string) => (k === 'zoneA' || k === 'itemB' ? '같은 글자' : k);
  expect(sectionHeader(group, same)).toEqual({ headerKey: null, name: '같은 글자' });
  const different = (k: string) => k;
  expect(sectionHeader(group, different).headerKey).toBe('zoneA');
});
