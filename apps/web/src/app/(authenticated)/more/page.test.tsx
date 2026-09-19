// @vitest-environment jsdom
//
// story #2682(모바일 IA S2) — 「전체」(/more)를 평면 stub에서 데스크톱 GNB(nav-config.ts)
// 미러 그룹형 허브로 재건한 회귀가드. AC1(org 그룹·조직브리핑 포함)·AC3(아코디언 없음·stub
// 배너 제거)·중복 방지(flow/inbox/chats는 바텀 탭이 이미 depth 1로 커버)를 실 렌더로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

// story #fddd0e6b(IA ⑦ 전체 메뉴 AC1②) — jsdom엔 window.matchMedia가 없어 훅 자체를
// 모킹한다(workspace-frame-tabs.test.tsx·flow-client.test.tsx와 동일 패턴). 기본은
// desktop(false) — 기존 핀 8건은 이 기본값으로 회귀 0 유지.
let isMobileMock = false;
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_BREAKPOINT: 1024,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, Provider: React.ComponentType<{ children: React.ReactNode }>) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <Provider>{node}</Provider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  isMobileMock = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount() {
  const { default: MorePage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => { root.render(wrap(<MorePage />, TopBarProvider)); });
}

describe('MorePage — story #2682 GNB 미러 그룹형 허브(AC1·AC3)', () => {
  // story #3824(UX-v3·FE 1, 페드루 PO 確定 2026-09-13 조건②) — 데스크톱 사이드바가
  // 5항목으로 줄어도 모바일 `/more`는 회귀 0(PO 조건) — NAV_GROUPS 미러 섹션 뒤에
  // LEGACY_NAV_ITEMS가 따라붙는다. 데스크톱 「보드」 자신의 「일감」(zoneDev) 섹션은
  // 그 유일한 항목(board)이 MOBILE_HUB_EXCLUDE_IDS에 있어 빈 채 안 뜬다(무변, 3824
  // 당시 그대로).
  // story #3855(customer-zero·셸, 페드루 PO 판정 2026-09-14 07:34Z 픽셀 커밋) — 「그 밖의
  // 화면」은 다시 단일 카드다(구 stub과 동형 카드 수, 내용만 다름) — §② 흡수 지도 머리말
  // (일감·연결·규칙·지식·이력·설정)은 그 카드 «안»의 소묶음(sub-heading, h2 아님)으로
  // 산다. h2 레벨엔 데스크톱 미러 3개(오늘·결과·연결·규칙) + legacy 카드 1개(그 밖의
  // 화면)뿐 — 소묶음 자체는 nav-config-legacy-grouping.test.ts·legacy-nav-ssot.test.tsx가
  // 전담(별도 축, 이 파일 관심사 아님).
  it('섹션(h2) 순서가 확定대로다(오늘/결과/연결·규칙[NAV_GROUPS]/그 밖의 화면[legacy 단일 카드] — 일감[NAV_GROUPS]은 유일 항목이 바텀탭 배제 대상이라 빈 채 안 뜬다)', async () => {
    await mount();
    const sectionLabels = [...container.querySelectorAll('h2')].map((el) => el.textContent?.trim());
    expect(sectionLabels).toEqual(['오늘', '결과', '연결·규칙', '그 밖의 화면새 자리로 옮기는 중이에요']);
    // h2 안 캡션은 "그 밖의 화면" 라벨과 별도 span(§⑤ 해요체 인라인 캡션, moreLegacyMovingCaptionInline)
    // — 위 concat 문자열이 그 둘의 합임을 명시로도 확認(텍스트 원문이 바뀌면 이 assert가 RED).
    const legacyH2 = [...container.querySelectorAll('h2')].find((h) => h.textContent?.startsWith('그 밖의 화면'));
    expect(legacyH2?.querySelector('[data-testid="legacy-moving-caption"]')?.textContent).toBe('새 자리로 옮기는 중이에요');
  });

  it('「그 밖의 화면」 묶음(레시피·구성원·에이전트)과 오늘(=옛 조직브리핑)이 포함된다(AC1 — 기존 stub의 핵심 결함 수복)', async () => {
    await mount();
    expect(container.textContent).toContain('레시피');
    expect(container.textContent).toContain('구성원');
    expect(container.textContent).toContain('에이전트');
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing');
    expect(todayLink).toBeDefined();
    expect(todayLink?.textContent).toContain('오늘');
  });

  it('flow·inbox·chats는 안 뜬다(바텀 탭이 이미 depth 1로 커버 — 중복 진입점 방지)', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')];
    expect(links.some((a) => a.getAttribute('href') === '/flow')).toBe(false);
    expect(links.some((a) => a.getAttribute('href') === '/inbox')).toBe(false);
    expect(links.some((a) => a.getAttribute('href') === '/chats')).toBe(false);
  });

  it('임시 stub 배너가 제거됐다(AC3)', async () => {
    await mount();
    expect(container.textContent).not.toContain('임시 목록');
  });

  it('아코디언이 아니다 — 전 섹션의 링크가 펼침 조작 없이 DOM에 항상 존재한다(AC3)', async () => {
    await mount();
    // <button aria-expanded>류 접이식 컨트롤이 그룹 헤더에 없다 — h2는 순수 텍스트.
    const toggles = [...container.querySelectorAll('[aria-expanded]')];
    expect(toggles.length).toBe(0);
    // story #4043(«이벤트»→«레시피» 낱말 통일) — 조직 그룹, 목록 순서상 뒤쪽 섹션이
    // 별도 조작 없이 이미 렌더돼 있다. 텍스트는 orgEvents 값을 따라 레시피로 바뀌었지만
    // href/route(/organization/events)는 이 카드 범위 밖(Tier2)이라 그대로.
    const eventsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('레시피'));
    expect(eventsLink?.getAttribute('href')).toBe('/organization/events');
  });

  it('정적 항목은 절대경로, resource 항목은 bare 폴백 href를 쓴다(리팩터 전 규약 보존)', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')];
    const membersLink = links.find((a) => a.textContent?.includes('구성원'));
    expect(membersLink?.getAttribute('href')).toBe('/organization/members');
    // story #2930 I3 — '스프린트'는 nav-config work 존에서 '보드'로 접혀 빠졌다(href는 옛
    // 흐름의 '/flow' 그대로 보존). resource 폴백 규약 자체를 확認하는 게 목적이라 대체 항목으로.
    const goalsLink = links.find((a) => a.textContent?.includes('목표'));
    expect(goalsLink?.getAttribute('href')).toBe('/goals');
  });

  it('doc a0da40c9 §21-1(2026-09-05) — 조직 그룹에 새로 추가됐던 성과 보드 항목(현 라벨 「결과」, story #3824 navResults 개명)이 이 모바일 허브에도 뜬다(하나만 서면 모바일 진입점이 아예 없다는 규율의 회귀가드)', async () => {
    await mount();
    const insightsBoardLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/insights-board');
    expect(insightsBoardLink?.textContent).toContain('결과');
  });

  // story #3855(customer-zero·셸, 페드루 PO 판정 2026-09-14 07:34Z 픽셀 커밋) — AC1 갈 곳
  // 표가 settings를 "묶음 없이 맨 아래 단독(머리말 「설정」)"으로 못박았지만, 픽셀 커밋이
  // legacy를 단일 카드로 되돌리며 그 머리말은 이제 h2(카드 헤더)가 아니라 카드 «안»의
  // 소묶음(data-legacy-group="settings")이다 — 데스크톱 사이드바와 동형(app-sidebar.tsx도
  // 소묶음, h2 아님).
  it('설정은 legacy 카드 안 자기 소묶음(머리말+개수 pill)을 갖는다(story #3855 §② 흡수 지도 — settings 전용 축)', async () => {
    await mount();
    const settingsGroup = container.querySelector('[data-legacy-group="settings"]');
    expect(settingsGroup).toBeDefined();
    expect(settingsGroup?.textContent).toContain('설정');
    const settingsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings');
    expect(settingsLink).toBeDefined();
  });
});

// story #fddd0e6b(IA ⑦ 전체 메뉴) — AC1 부제(수는 별도 파일 page.subtitle-data-driven.test.tsx
// 에서 SSOT 교체로 검증) · AC1② 탭 문장(useIsMobile) · AC2 설명 한 줄(23개 완전성은
// nav-config-descriptions.test.ts) · AC3 찾기 · AC4 형(Card·min-h-12·아코디언 0은 이미 위
// 「아코디언이 아니다」 핀이 재사용) 회귀가드.
describe('MorePage — story #fddd0e6b(IA ⑦ 전체 메뉴)', () => {
  function searchInput() {
    return container.querySelector('[data-testid="more-search-input"]') as HTMLInputElement;
  }

  async function typeQuery(value: string) {
    const input = searchInput();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('행마다 「무엇이 여기 있나」 한 줄(descriptionKey)이 이름 아래 선다(AC2)', async () => {
    await mount();
    const membersLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('구성원'));
    expect(membersLink?.textContent).toContain('사람과 에이전트 명단');
  });

  it('⭐탭 문장은 useIsMobile() true일 때만 서고, 나올 땐 nav 이름 셋+탭 이름 셋을 조립한다(AC1②) — story #3824 CHANGES②: 탭 이름 中 「오늘」·「대화」는 nav.zoneNow·nav.chats와 같은 labelKey 공유(「결재」만 mobileTabBar 자기 키)', async () => {
    isMobileMock = true;
    await mount();
    const hint = container.querySelector('[data-testid="more-tab-hint"]');
    expect(hint?.textContent).toBe('보드·알림·대화는 아래 「오늘」·「결재」·「대화」 탭에 있어 여기엔 없어요');
  });

  it('⭐데스크톱 폭(useIsMobile() false)에선 탭 문장이 아예 없다(탭 바 자체가 없어 거짓이 되므로)', async () => {
    isMobileMock = false;
    await mount();
    expect(container.querySelector('[data-testid="more-tab-hint"]')).toBeNull();
  });

  // story #3845(§①④, 2026-09-14) — retro·standup이 LEGACY_NAV_ITEMS에서 빠지며(각각
  // 「일감」 탭으로 흡수) '회고'·'스탠드업' 질의가 0건이 된다. 단독매치 검증 취지는
  // 그대로 두고 검색어만 흡수 대상이 아닌 고유명 'loops'로 바꾼다(다른 항목 이름/
  // 설명과 안 겹침).
  it('⭐찾기 — 입력값이 이름에 매치하면 그 행만 남고 나머지 구역은 숨는다', async () => {
    await mount();
    await typeQuery('실행');
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain('실행');
  });

  it('⭐찾기 — 입력값이 설명에만 매치해도 걸린다(이름+설명 둘 다 부분일치)', async () => {
    await mount();
    // '기억'(org-memory) 설명 = "에이전트가 쌓은 것 — 사람이 안 씀" — '쌓은'은 설명에만 있다.
    await typeQuery('쌓은');
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain('기억');
  });

  it('⭐찾기 — 0건이면 「「{q}」에 맞는 화면이 없어요」 한 줄만 뜨고 카드는 0장', async () => {
    await mount();
    await typeQuery('zzz-no-such-screen');
    // story #3913 — 리터럴 재-pin 대신 ko.json 템플릿 값을 {q} 치환해 대조.
    expect(container.querySelector('[data-testid="more-search-empty"]')?.textContent).toBe(
      koMessages.nav.moreSearchEmpty.replace('{q}', 'zzz-no-such-screen'),
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('⭐찾기 — 지우면 전량 복귀한다(story #3824로 총 링크 수 변동, 리터럴 수 대신 >1로 검증)', async () => {
    await mount();
    await typeQuery('실행');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    await typeQuery('');
    expect(container.querySelectorAll('a').length).toBeGreaterThan(1);
  });

  it('찾기 placeholder에 ⌘K를 언급하지 않는다(폰엔 키보드 단축키가 없어 거짓)', async () => {
    await mount();
    expect(searchInput().getAttribute('placeholder')).toBe('화면 이름으로 찾기');
    expect(searchInput().getAttribute('placeholder')).not.toContain('⌘');
  });

  it('구역은 Card 프리미티브다(data-slot="card")·행은 min-h-12 터치 타깃을 유지한다(AC4)', async () => {
    await mount();
    expect(container.querySelectorAll('[data-slot="card"]').length).toBeGreaterThan(0);
    const membersLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('구성원'));
    expect(membersLink?.className).toContain('min-h-12');
  });
});
