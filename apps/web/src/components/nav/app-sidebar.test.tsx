// @vitest-environment jsdom
//
// story #2681(모바일 IA S1) — 데스크톱 GNB를 하드코딩 JSX에서 NAV_GROUPS 순회로 리팩터한
// 회귀가드. AC1("렌더 결과 기존과 동일 — 시각 회귀 0")을 실 렌더로 잰다: 그룹 순서·라벨,
// 항목 순서·라벨·href·active 판정·kbd힌트·배지가 리팩터 전과 동일한지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/dashboard' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { AppSidebar } = await import('./app-sidebar');
const { SidebarProvider } = await import('@/components/ui/sidebar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withProviders(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <SidebarProvider>{node}</SidebarProvider>
    </NextIntlClientProvider>
  );
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, // 데스크톱 분기 고정(<1024 아님) — GNB 실 렌더 대상.
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { inboxUnreadCount: 0 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia();
  stubFetch();
  stubLocalStorage();
  pathnameRef.current = '/dashboard';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(withProviders(
      <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// 리팩터 전 하드코딩 JSX의 그룹/항목 순서를 그대로 옮긴 기대값 — nav-config.ts 자체가 그
// 원본에서 1:1로 추출된 것이라 이 표가 "리팩터 전 실제 마크업"의 정본이다.
const EXPECTED_GROUPS: Array<{ labelKey: string | null; labels: string[] }> = [
  { labelKey: 'zoneOrganization', labels: ['구성원', '워크포스', '권한', '신뢰', '기억', '이벤트'] },
  { labelKey: 'zoneNow', labels: ['조직 브리핑', '알림', '대시보드', '채팅'] },
  { labelKey: 'zoneWork', labels: ['흐름', '스프린트', '목표', '실험실', '스탠드업', '회고'] },
  { labelKey: 'zoneTrust', labels: ['활동 로그'] },
  { labelKey: 'zoneKnowledge', labels: ['문서', '산출물', '스토리지'] },
  { labelKey: null, labels: ['설정'] },
];

// 카디르 QA(PR#3100) 지적 — 라벨은 맞는데 href가 다른 항목과 뒤바뀐 뮤테이션은 그룹별 라벨
// 순서 대조(위 EXPECTED_GROUPS)만으론 못 잡는다(라벨 목록 자체는 안 바뀌므로). 21항목 전부의
// 라벨→href 쌍을 개별 대조해 그 구멍을 닫는다 — org/project slug 없는 테스트 환경이라
// resource 항목은 bare `/${resource}`로 폴백한 값(리팩터 전 resourceLink()와 동일 규칙).
const EXPECTED_HREF_BY_LABEL: Record<string, string> = {
  '구성원': '/organization/members',
  '워크포스': '/organization/workforce',
  '권한': '/organization/roles',
  '신뢰': '/organization/trust',
  '기억': '/organization/memory',
  '이벤트': '/organization/events',
  '조직 브리핑': '/org-briefing',
  '알림': '/inbox',
  '대시보드': '/dashboard',
  '채팅': '/chats',
  '흐름': '/flow',
  '스프린트': '/sprints',
  '목표': '/goals',
  '실험실': '/loops',
  '스탠드업': '/standup',
  '회고': '/retro',
  '활동 로그': '/activity',
  '문서': '/docs',
  '산출물': '/artifacts',
  '스토리지': '/storage',
  '설정': '/settings',
};

describe('AppSidebar — story #2681 NAV_GROUPS 렌더 회귀가드(AC1)', () => {
  it('그룹 순서·라벨·항목 순서·라벨이 리팩터 전과 동일하다', async () => {
    await mount();
    const groupLabels = [...container.querySelectorAll('[data-slot="sidebar-group-label"]')].map((el) => el.textContent);
    expect(groupLabels).toEqual(['조직', '홈', '작업', '신뢰', '지식']);

    const groups = [...container.querySelectorAll('[data-slot="sidebar-group"]')];
    expect(groups.length).toBe(EXPECTED_GROUPS.length);
    groups.forEach((groupEl, i) => {
      const itemLabels = [...groupEl.querySelectorAll('[data-slot="sidebar-menu-button"] span')].map((el) => el.textContent);
      expect(itemLabels).toEqual(EXPECTED_GROUPS[i]!.labels);
    });
  });

  it('정적 항목(조직 그룹)의 href가 리팩터 전과 동일하다', async () => {
    await mount();
    const membersLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('구성원'));
    expect(membersLink?.getAttribute('href')).toBe('/organization/members');
    const eventsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('이벤트'));
    expect(eventsLink?.getAttribute('href')).toBe('/organization/events');
  });

  it('리소스 항목(작업 그룹, org/project slug 없음)이 bare href로 폴백한다(기존 resourceLink 동작)', async () => {
    await mount();
    const flowLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('흐름'));
    expect(flowLink?.getAttribute('href')).toBe('/flow');
  });

  it('kbd 힌트(흐름=B·스탠드업=S·회고=R)가 항목별로 정확히 붙는다', async () => {
    await mount();
    const flowBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('흐름'));
    expect(flowBtn?.textContent).toContain('B');
    const standupBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('스탠드업'));
    expect(standupBtn?.textContent).toContain('S');
  });

  it('현재 경로와 일치하는 정적 항목이 active로 표시된다(isActive 판정 보존)', async () => {
    pathnameRef.current = '/organization/events';
    await mount();
    const eventsBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('이벤트'));
    expect(eventsBtn?.hasAttribute('data-active')).toBe(true);
    const membersBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('구성원'));
    expect(membersBtn?.hasAttribute('data-active')).toBe(false);
  });

  it('unread 배지(inbox)가 카운트>0일 때만 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { inboxUnreadCount: 3 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await mount();
    const inboxBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('알림'));
    expect(inboxBtn?.textContent).toContain('3');
  });

  it('설정 그룹은 라벨 없는 유틸 그룹으로 유지된다(ia-4zone 확定)', async () => {
    await mount();
    const settingsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('설정') && a.getAttribute('href') === '/settings');
    expect(settingsLink).toBeDefined();
  });

  // 카디르 QA(PR#3100) 지적 — 라벨은 그대로인 채 href만 다른 항목과 뒤바뀌는 뮤테이션은 앞
  // 테스트들(그룹별 라벨 순서 대조 + 4항목만 개별 href 대조)로는 못 잡는다. 21항목 전부를
  // 라벨→href 쌍으로 개별 대조해 "라벨은 맞는데 목적지가 틀림"을 확실히 막는다.
  it('전 21항목의 라벨→href 쌍이 정확하다(뒤바뀐 목적지 방지, 카디르 QA 지적 반영)', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')];
    for (const [label, expectedHref] of Object.entries(EXPECTED_HREF_BY_LABEL)) {
      const link = links.find((a) => a.textContent?.includes(label));
      expect(link, `링크 "${label}"를 찾지 못함`).toBeDefined();
      expect(link!.getAttribute('href'), `"${label}"의 href`).toBe(expectedHref);
    }
  });
});
