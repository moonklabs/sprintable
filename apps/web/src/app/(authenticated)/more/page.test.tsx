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

// story #3146(모바일 계정 스위치) — MorePage가 useDashboardContext()로 userName을 얻어
// ProfileMenu 마운트 여부를 결정한다. 기존 스위트는 이 훅을 안 모킹해(디폴트 컨텍스트,
// userName=undefined) 계정 섹션이 항상 생략되는 경로만 탔다 — 아래 새 describe에서만
// userName을 주입해 반대 경로(섹션이 실제로 뜨는지)를 명시적으로 잰다.
const useDashboardContextMock = vi.fn(() => ({} as { userName?: string }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
// ProfileMenu(계정 스위치 트리거)가 useRouter()를 쓴다 — profile-menu.test.tsx와 동일 모킹.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/more',
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({}); // 기본=기존 스위트와 동형(userName 없음).
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { accounts: [] } }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { default: MorePage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => { root.render(wrap(<MorePage />, TopBarProvider)); });
}

describe('MorePage — story #2682 GNB 미러 그룹형 허브(AC1·AC3)', () => {
  // story #2930(P0-G) I1 — zoneNow/zoneWork 텍스트가 "오늘"/"워크스페이스"로 개명(시안
  // ia-4zone-redesign-2930 그대로). 순서 자체(오늘→워크스페이스→신뢰→지식→조직→설정)는
  // MOBILE_HUB_GROUP_ORDER 무변화 — 데스크톱이 이 순서를 따라잡았을 뿐, 모바일은 원래도 이
  // 순서였다(더 이상 "데스크톱과 다른 순서"가 아니다, app-sidebar.test.tsx도 동일 순서로 갱신).
  it('섹션 순서가 doc §2.3 그대로다(오늘/워크스페이스/신뢰/지식/조직/설정)', async () => {
    await mount();
    const sectionLabels = [...container.querySelectorAll('h2')].map((el) => el.textContent);
    expect(sectionLabels).toEqual(['오늘', '워크스페이스', '신뢰', '지식', '조직', '설정']);
  });

  it('조직 그룹(이벤트 포함)과 조직브리핑이 포함된다(AC1 — 기존 stub의 핵심 결함 수복)', async () => {
    await mount();
    expect(container.textContent).toContain('이벤트');
    expect(container.textContent).toContain('구성원');
    expect(container.textContent).toContain('워크포스');
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

  it('설정 섹션이 그룹 라벨로 뜬다(desktop 무라벨 footer와 달리 허브에선 명시 섹션)', async () => {
    await mount();
    const settingsSection = [...container.querySelectorAll('h2')].find((h) => h.textContent === '설정');
    expect(settingsSection).toBeDefined();
    const settingsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings');
    expect(settingsLink).toBeDefined();
  });
});

// story #3146(선생님 실사용 발견) — "모바일에서 로그아웃 외엔 계정을 바꿀 방법이 없다".
// ProfileMenu(계정 스위처)가 데스크톱 AppSidebar에만 마운트되고 모바일 표면 어디에도
// 진입점이 없던 것을 이 허브 최상단에 추가한 회귀가드.
describe('MorePage — story #3146 계정 스위치 진입점(모바일)', () => {
  it('userName이 있으면 최상단에 계정 스위치(ProfileMenu) 트리거가 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({ userName: '송윤재' });
    await mount();
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]');
    expect(trigger).toBeTruthy();
    expect(trigger!.textContent).toContain('송윤재');
  });

  it('userName이 없으면(컨텍스트 미준비) 계정 섹션 자체를 생략한다 — 빈 트리거로 지어내지 않음', async () => {
    useDashboardContextMock.mockReturnValue({});
    await mount();
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]');
    expect(trigger).toBeNull();
  });

  it('기존 GNB 미러 섹션(오늘/워크스페이스/…) 순서·내용은 계정 섹션 추가 후에도 무회귀', async () => {
    useDashboardContextMock.mockReturnValue({ userName: '송윤재' });
    await mount();
    const sectionLabels = [...container.querySelectorAll('h2')].map((el) => el.textContent);
    expect(sectionLabels).toEqual(['오늘', '워크스페이스', '신뢰', '지식', '조직', '설정']);
  });
});
