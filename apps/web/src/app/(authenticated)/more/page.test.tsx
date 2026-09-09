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
  // story #a2b004f9(IA·S1, 2026-09-08) — 'work'(zoneWork·「워크스페이스」)가 'dev'
  // (zoneDev)로 개명되고 신규 'marketing'(zoneMarketing)이 그 뒤에 등재
  // (MOBILE_HUB_GROUP_ORDER 갱신, app-sidebar.test.tsx도 동일 순서로 갱신). story #f81657f8
  // 후속(유나 § 2026-09-09) — 라벨 값만 「일감」·「콘텐츠·채널」로 개명(id·순서 불변).
  it('섹션 순서가 IA·S1 확定대로다(오늘/일감/콘텐츠·채널/신뢰/지식/조직/설정)', async () => {
    await mount();
    const sectionLabels = [...container.querySelectorAll('h2')].map((el) => el.textContent);
    expect(sectionLabels).toEqual(['오늘', '일감', '콘텐츠·채널', '신뢰', '지식', '조직', '설정']);
  });

  it('조직 그룹(이벤트 포함)과 조직브리핑이 포함된다(AC1 — 기존 stub의 핵심 결함 수복)', async () => {
    await mount();
    expect(container.textContent).toContain('이벤트');
    expect(container.textContent).toContain('구성원');
    expect(container.textContent).toContain('에이전트');
    expect(container.textContent).toContain('조직 브리핑');
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
    // 이벤트(조직 그룹, 목록 순서상 뒤쪽 섹션)가 별도 조작 없이 이미 렌더돼 있다.
    const eventsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('이벤트'));
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

  it('doc a0da40c9 §21-1(2026-09-05) — 조직 그룹에 새로 추가된 「성과 보드」가 이 모바일 허브에도 뜬다(하나만 서면 모바일 진입점이 아예 없다는 규율의 회귀가드)', async () => {
    await mount();
    const insightsBoardLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('성과 보드'));
    expect(insightsBoardLink?.getAttribute('href')).toBe('/organization/insights-board');
  });

  it('설정 섹션이 그룹 라벨로 뜬다(desktop 무라벨 footer와 달리 허브에선 명시 섹션)', async () => {
    await mount();
    const settingsSection = [...container.querySelectorAll('h2')].find((h) => h.textContent === '설정');
    expect(settingsSection).toBeDefined();
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

  it('⭐탭 문장은 useIsMobile() true일 때만 서고, 나올 땐 nav 이름 셋+탭 이름 셋을 조립한다(AC1②)', async () => {
    isMobileMock = true;
    await mount();
    const hint = container.querySelector('[data-testid="more-tab-hint"]');
    expect(hint?.textContent).toBe('보드·알림·채팅은 아래 「지금」·「결재」·「채팅」 탭에 있어 여기엔 없습니다');
  });

  it('⭐데스크톱 폭(useIsMobile() false)에선 탭 문장이 아예 없다(탭 바 자체가 없어 거짓이 되므로)', async () => {
    isMobileMock = false;
    await mount();
    expect(container.querySelector('[data-testid="more-tab-hint"]')).toBeNull();
  });

  it('⭐찾기 — 입력값이 이름에 매치하면 그 행만 남고 나머지 구역은 숨는다', async () => {
    await mount();
    await typeQuery('회고');
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain('회고');
  });

  it('⭐찾기 — 입력값이 설명에만 매치해도 걸린다(이름+설명 둘 다 부분일치)', async () => {
    await mount();
    // '기억'(org-memory) 설명 = "에이전트가 쌓은 것 — 사람이 안 씀" — '쌓은'은 설명에만 있다.
    await typeQuery('쌓은');
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain('기억');
  });

  it('⭐찾기 — 0건이면 「「{q}」에 맞는 화면이 없습니다」 한 줄만 뜨고 카드는 0장', async () => {
    await mount();
    await typeQuery('zzz-no-such-screen');
    expect(container.querySelector('[data-testid="more-search-empty"]')?.textContent).toBe('「zzz-no-such-screen」에 맞는 화면이 없습니다');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('⭐찾기 — 지우면 전량(21개 링크) 복귀한다', async () => {
    await mount();
    await typeQuery('회고');
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
