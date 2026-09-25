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

// story #f81657f8(IA·S4/S1 후속, 2026-09-09) — 기본 접힘 집합은 이제 항상 빈 Set(전부
// 펼침)이라 이 helper는 엄밀히는 더 이상 필수가 아니다(기본값 자체가 이미 전부 펼침).
// 그래도 "이 테스트는 접힘 前 구조를 재는 게 목적"이라는 의도를 명시적으로 남겨 두는 게
// 읽기에 낫다고 판단해 그대로 둔다(오버라이드가 기본값과 같은 값을 다시 심을 뿐 — 무해).
function expandAllGroups() {
  localStorage.setItem('sidebar_group_collapsed', JSON.stringify({
    'connect-rules': false,
  }));
}

// story #f81657f8 후속 — 뷰포트 높이가 이제 기본 접힘 계산과 무관하다는 것 자체를 재는
// 회귀가드용 스텁(옛 문턱 872는 폐기됐다).
function stubViewportHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
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

async function mount(userName?: string, navV3Flags?: { todayV3Enabled: boolean; chatV3Enabled: boolean; connectRulesV3Enabled: boolean }) {
  await act(async () => {
    root.render(withProviders(
      <AppSidebar projectMemberships={[]} chatUnreadTotal={0} userName={userName} navV3Flags={navV3Flags} />,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// story #3824(UX-v3·FE 1, 페드루 PO 確定 2026-09-13, doc a699be00 §② 흡수 지도) — 앱 셸
// 5항목(오늘·대화·일감·결과·연결·규칙)으로 축소. 「오늘」은 목적지는 여전히 org-briefing
// (path 무변)이지만 라벨이 「조직 브리핑」→「오늘」로, 「일감」은 board(path=/flow 무변)가
// 「보드」→「일감」으로, 「결과」는 org-insights-board(path 무변)가 「성과 보드」→「결과」로
// 리라벨된다(라벨키만 갈림, navResults 신설 — orgInsightsBoard 재사용 시 insight-snapshot-
// block.tsx의 다른 문맥 CTA까지 같이 바뀌는 걸 피함). 「연결·규칙」만 진짜 라벨 그룹(하위
// 채널 연결/콘텐츠 규칙 2항목, 라벨·path 둘 다 무변 — story #4116(2026-09-21)이 채널
// 연결의 형제 화면 「연산 커넥터」를 그 사이에 신설, 3항목으로) — 나머지 3(오늘·일감·결과)은 항목
// 하나뿐인 헤더리스 그룹(옛 'settings' 그룹과 동형 관례, 접기 토글 없음). 「대화」는 이
// 배열 밖 CHAT_CENTER_ITEM 그대로(라벨만 "채팅"→"대화"). 나머지 17항목(goals·loops·
// standup·retro·docs·artifacts·storage·activity·org-trust·org-memory(#4183에서 제거)·content·channel-
// posts·org-members·org-workforce·org-roles·org-events·inbox·settings)은 사이드바에서
// 빠지고 LEGACY_NAV_ITEMS로 이관(커맨드 팔레트·모바일 /more 「그 밖의 화면」이 1급
// 진입점, 별도 스위트에서 검증) — path는 전부 불변(북마크·딥링크 무손상).
const EXPECTED_GROUPS: Array<{ labelKey: string | null; labels: string[] }> = [
  { labelKey: null, labels: ['오늘'] },
  { labelKey: null, labels: ['일감'] },
  { labelKey: null, labels: ['결과'] },
  { labelKey: 'zoneConnectRules', labels: ['채널 연결', '연산 커넥터', '콘텐츠 규칙'] },
  // story #3836(UX-v3·셸 후속) — 「더보기」(LEGACY_GROUP_ID)는 기본 접힘(AC1)이라 이
  // 테스트(expandAllGroups가 'connect-rules'만 편다)에선 항목이 DOM에 없다 — 그룹
  // 자체(라벨+토글)는 렌더된다는 사실만 여기서 잠그고, 내용물은 전용 스위트에서.
  { labelKey: 'navMore', labels: [] },
];

// 카디르 QA(PR#3100) 지적 — 라벨은 맞는데 href가 다른 항목과 뒤바뀐 뮤테이션은 그룹별 라벨
// 순서 대조(위 EXPECTED_GROUPS)만으론 못 잡는다. 5항목(챗 center 제외 4 + 챗 center 1,
// 아래 별도 스위트) 전부의 라벨→href 쌍을 개별 대조해 그 구멍을 닫는다.
// story #4003 — flag OFF(이 스위트의 기본 렌더 조건, navV3Flags 미전달)에서 5항목
// 전부 지금 develop과 바이트 동일(회귀 0). 「일감」의 flag-aware work-list 전환은
// 별도 describe(하단 "v3 nav 단일 소스" 스위트)가 ON 케이스로 검증.
const EXPECTED_HREF_BY_LABEL: Record<string, string> = {
  '오늘': '/org-briefing',
  '일감': '/flow',
  '결과': '/organization/insights-board',
  '채널 연결': '/organization/channels',
  '연산 커넥터': '/organization/generation-connectors',
  '콘텐츠 규칙': '/organization/content-rules',
};

describe('AppSidebar — story #3824 5항목 축소 렌더 회귀가드(UX-v3·FE 1)', () => {
  it('그룹 순서·라벨·항목 순서·라벨이 확定대로다(오늘→일감→결과→연결·규칙)', async () => {
    expandAllGroups();
    await mount();
    // 헤더리스 그룹(오늘·일감·결과)은 sidebar-group-label 자체가 없다 — 라벨 그룹은
    // 「연결·규칙」 하나뿐.
    const groupLabels = [...container.querySelectorAll('[data-slot="sidebar-group-label"]')].map((el) => el.textContent);
    expect(groupLabels).toEqual(['연결·규칙', '더보기']);

    const groups = [...container.querySelectorAll('[data-slot="sidebar-group"]')];
    expect(groups.length).toBe(EXPECTED_GROUPS.length);
    groups.forEach((groupEl, i) => {
      const itemLabels = [...groupEl.querySelectorAll('[data-slot="sidebar-menu-button"] span[data-nav-label]')].map((el) => el.textContent);
      expect(itemLabels).toEqual(EXPECTED_GROUPS[i]!.labels);
    });
  });

  // story #3824 CHANGES①(페드루 PO 確定, 2026-09-13 09:01Z, PR#4251 캡처 리뷰) — 정본
  // 순서는 오늘→대화→일감→결과→연결·규칙(「오늘」=첫 화면). 「대화」(챗 center)는
  // NAV_GROUPS 밖 1급이라 위 그룹 순서 대조(sidebar-group 축)엔 안 잡힌다 — DOM 내
  // 링크 등장 순서로 직접 잰다. 처음엔 챗 center가 SidebarHeader 바로 뒤(오늘보다
  // 먼저) 렌더돼 이 순서를 어겼다(실측·PO 지적으로 발견).
  it('「대화」가 「오늘」보다 뒤·「일감」보다 앞에 온다(DOM 등장 순서, CHANGES① 회귀가드)', async () => {
    expandAllGroups();
    await mount();
    const links = [...container.querySelectorAll('a')];
    const todayIndex = links.findIndex((a) => a.textContent?.includes('오늘'));
    const chatsIndex = links.findIndex((a) => a.textContent?.includes('대화'));
    const workIndex = links.findIndex((a) => a.textContent?.includes('일감'));
    expect(todayIndex).toBeGreaterThanOrEqual(0);
    expect(chatsIndex).toBeGreaterThanOrEqual(0);
    expect(workIndex).toBeGreaterThanOrEqual(0);
    expect(todayIndex).toBeLessThan(chatsIndex);
    expect(chatsIndex).toBeLessThan(workIndex);
  });

  it('정적 항목(연결·규칙 그룹)의 href가 무변화다(path 전부 불변)', async () => {
    expandAllGroups();
    await mount();
    const channelsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'));
    expect(channelsLink?.getAttribute('href')).toBe('/organization/channels');
    const rulesLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('콘텐츠 규칙'));
    expect(rulesLink?.getAttribute('href')).toBe('/organization/content-rules');
  });

  it('리소스 항목(일감, org/project slug 없음)이 bare href로 폴백한다(기존 resourceLink 동작)', async () => {
    expandAllGroups();
    await mount();
    // startsWith 유지 — kbd 힌트 접미사가 붙는 항목이 있어 정확한 === 매칭은 못 쓴다.
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.getAttribute('href')).toBe('/flow');
  });

  it('kbd 힌트(일감=B)가 정확히 붙는다', async () => {
    expandAllGroups();
    await mount();
    const workBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workBtn?.textContent).toContain('B');
  });

  // story #9c5e82dc(IA·S3, 유나 § 確定 2026-09-08) — 「프로젝트」 표식은 scope:'project'
  // 항목에만 붙는다(오늘·일감의 사이드바 잔존 항목 중 「일감」이 유일한 project 표본).
  it('scope:project 항목(일감)엔 「프로젝트」 표식이 붙는다', async () => {
    expandAllGroups();
    await mount();
    const workBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workBtn?.textContent).toContain('프로젝트');
  });

  it('org 항목(채널 연결)엔 「프로젝트」 표식이 안 붙는다', async () => {
    expandAllGroups();
    await mount();
    const channelsBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'));
    expect(channelsBtn?.textContent).not.toContain('프로젝트');
  });

  it('애매 항목(오늘)엔 「프로젝트」 표식이 안 붙는다', async () => {
    expandAllGroups();
    await mount();
    const todayBtn = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(todayBtn?.textContent).not.toContain('프로젝트');
  });

  it('순서는 라벨→표식→kbd다(일감: "일감" 다음 "프로젝트" 다음 "B")', async () => {
    expandAllGroups();
    await mount();
    const workBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    const text = workBtn?.textContent ?? '';
    const labelIdx = text.indexOf('일감');
    const scopeIdx = text.indexOf('프로젝트');
    const kbdIdx = text.lastIndexOf('B');
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBeGreaterThan(labelIdx);
    expect(kbdIdx).toBeGreaterThan(scopeIdx);
  });

  it('표식은 칩/배지 모양(테두리·배경)을 안 쓴다(유나 § — 성질이지 행위가 아니다)', async () => {
    expandAllGroups();
    await mount();
    const workBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    const scopeEl = [...(workBtn?.querySelectorAll('span') ?? [])].find((s) => s.textContent === '프로젝트');
    expect(scopeEl).toBeDefined();
    expect(scopeEl?.className).not.toMatch(/border|bg-/);
  });

  it('현재 경로와 일치하는 정적 항목이 active로 표시된다(isActive 판정 보존)', async () => {
    pathnameRef.current = '/organization/channels';
    expandAllGroups();
    await mount();
    const channelsBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('채널 연결'));
    expect(channelsBtn?.hasAttribute('data-active')).toBe(true);
    const rulesBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('콘텐츠 규칙'));
    expect(rulesBtn?.hasAttribute('data-active')).toBe(false);
  });

  // story #1981/#3084 배지 축 — 사이드바에서 'inbox' 항목 자체가 빠졌으므로(LEGACY_NAV_
  // ITEMS 이관, #3823 「오늘」 배지 카드가 재연결 예정) 이제 어떤 사이드바 버튼도 이
  // 배지를 안 그린다 — 폴링 로직(app-sidebar.tsx)은 그대로 살아있다는 것만 확認한다
  // (다음 카드가 그 값을 그대로 재사용할 수 있게).
  it('결재 대기 카운트가 있어도(inbox 항목 자체가 사이드바에서 빠짐) 어떤 사이드바 버튼도 배지를 안 그린다', async () => {
    expandAllGroups();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 3 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await mount();
    const badges = [...container.querySelectorAll('[data-slot="sidebar-menu-badge"]')];
    expect(badges).toHaveLength(0);
  });

  it('헤더리스 그룹(오늘·일감·결과)엔 접기 토글이 없다(옛 설정 그룹과 동형 관례)', async () => {
    await mount();
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(todayLink).toBeDefined();
    const toggles = [...container.querySelectorAll('button[aria-expanded]')];
    expect(toggles.some((b) => b.textContent?.includes('오늘'))).toBe(false);
    expect(toggles.some((b) => b.textContent?.includes('일감'))).toBe(false);
    expect(toggles.some((b) => b.textContent?.includes('결과'))).toBe(false);
  });

  // 카디르 QA(PR#3100) 지적 — 라벨은 그대로인 채 href만 다른 항목과 뒤바뀌는 뮤테이션은 앞
  // 테스트들로는 못 잡는다. 5항목(챗 center 제외) 전부를 라벨→href 쌍으로 개별 대조.
  it('전 5항목(챗 center 제외)의 라벨→href 쌍이 정확하다(뒤바뀐 목적지 방지, 카디르 QA 지적 반영)', async () => {
    expandAllGroups();
    await mount();
    const links = [...container.querySelectorAll('a')];
    for (const [label, expectedHref] of Object.entries(EXPECTED_HREF_BY_LABEL)) {
      // story #3402(페드루 PO 실측, PR#3768 CI red) — exact match 우선, 없으면 startsWith
      // 폴백(kbd 힌트 접미사 항목 대비).
      const link = links.find((a) => a.textContent === label) ?? links.find((a) => a.textContent?.startsWith(label));
      expect(link, `링크 "${label}"를 찾지 못함`).toBeDefined();
      expect(link!.getAttribute('href'), `"${label}"의 href`).toBe(expectedHref);
    }
  });

  // story #2870 — footer `?` docs 도움말 링크(docsLink)가 「사업자 정보」 토글로 대체됐다.
  // /docs는 이미 knowledge 그룹의 1차 내비 항목이라 footer 단축 제거로 도달성 손실은 없다.
  it('footer에 docs 도움말 링크(?)가 없고, 「사업자 정보」 토글이 대신 존재한다', async () => {
    await mount();
    const docsHelpLink = [...container.querySelectorAll('a[href="/docs"][aria-label]')];
    expect(docsHelpLink).toHaveLength(0);
    const businessInfoToggle = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-expanded') !== null);
    expect(businessInfoToggle).toBeDefined();
  });

  // story #3054(2984-S6) — Chat Center CTA가 헤어라인+elev를 쓰고 bg-proof-blue-soft는
  // 안 쓴다.
  it('Chat Center CTA가 헤어라인+elev를 쓰고 bg-proof-blue-soft는 안 쓴다', async () => {
    await mount();
    const link = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats');
    expect(link).toBeDefined();
    expect(link!.className).toContain('border-proof-blue');
    expect(link!.className).toContain('shadow-[var(--elev-card)]');
    expect(link!.className).not.toContain('bg-proof-blue-soft');
  });

  // story #f81657f8(IA·S4/S1 후속, 선생님 決 2026-09-09 01:28Z 「그냥 디폴트를 다 펼쳐두고
  // 접을 수 있게 하면 좋을 것 같다」) — story #d986fd6c의 뷰포트 높이 역산 접힘 규칙(기본은
  // 활성 구역만 펼침·뷰포트 ≥872px면 「오늘」도 얹음)을 폐기했다. 기본 접힘 집합은 이제
  // 뷰포트/활성 구역과 완전히 무관한 빈 Set(전부 펼침) — 아래는 그 대체 회귀가드다
  // (mutation-kill: 옛 규칙이 되살아나면 이 셋 다 RED로 돌아간다).
  it('기억 없는 새 브라우저 — 활성 구역이 없어도(경로=/dashboard) 전 구역이 펼쳐진다(옛 규칙이면 전부 접혔어야 함)', async () => {
    stubViewportHeight(700);
    await mount();
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(todayLink).toBeDefined();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink).toBeDefined();
    // 구역 토글 버튼만 좁혀서 잰다 — 컨테이너 전체 button[aria-expanded]는 다른 컴포넌트
    // (드롭다운·스위처 등)의 닫힌 트리거도 걸려 오탐한다. story #3836 — 「더보기」는
    // 이 f81657f8 규칙 밖의 별도 기본값(기본 접힘, AC1)이라 이 대조에서 뺀다(전용
    // 스위트가 그 기본값을 따로 잠근다).
    const toggles = [...container.querySelectorAll('[data-slot="sidebar-group-label"]')]
      .filter((b) => b.textContent !== '더보기');
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggles.every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true);
  });

  it('활성 구역이 있어도(경로=연결/채널) 비활성 구역(일감)까지 펼쳐진다(옛 규칙이면 접혔어야 함)', async () => {
    pathnameRef.current = '/organization/channels';
    stubViewportHeight(700);
    await mount();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink).toBeDefined();
  });

  it('뷰포트 높이 800과 1080 둘 다 기본값이 전부 펼침(접힘 0)이다 — 높이 의존 0', async () => {
    for (const height of [800, 1080]) {
      stubViewportHeight(height);
      await mount();
      // story #3836 — 「더보기」는 이 회귀가드 밖(별도 기본값, AC1), 위 테스트와 동일 이유로 제외.
      const toggles = [...container.querySelectorAll('[data-slot="sidebar-group-label"]')]
        .filter((b) => b.textContent !== '더보기');
      expect(toggles.every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true);
      await act(async () => { root.unmount(); });
      container.remove();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
  });

  it('구역 헤더를 클릭하면 접히고(항목 DOM에서 사라짐) 다시 클릭하면 펴진다', async () => {
    await mount();
    const crHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결·규칙'));
    expect(crHeader).toBeDefined();
    expect(crHeader?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { crHeader!.click(); });
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'))).toBeUndefined();
    const crHeaderAfter = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결·규칙'));
    expect(crHeaderAfter?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { crHeaderAfter!.click(); });
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'))).toBeDefined();
  });

  // 카디르 QA(a11y, §22-18 가드) — render prop 버튼이 SidebarGroupLabel의 children(그룹명
  // 텍스트+쉐브론)을 감싸긴 하지만, 접근성 트리에서 버튼 자체의 이름은 aria-label로
  // 명시해야 스크린리더가 구역 토글을 구별한다(textContent만으론 landmark 목록 등에서
  // 이름이 안 실리는 경우가 있다) — aria-label에 그룹명+접힘상태를 담는다.
  it('구역 토글 버튼의 aria-label이 그룹명+접힘상태를 담는다(카디르 QA a11y 처방)', async () => {
    expandAllGroups();
    await mount();
    const crHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결·규칙'));
    expect(crHeader?.getAttribute('aria-label')).toBe('연결·규칙 접기');

    await act(async () => { crHeader!.click(); });
    const crHeaderAfter = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결·규칙'));
    expect(crHeaderAfter?.getAttribute('aria-label')).toBe('연결·규칙 펼치기');
  });

  it('접힘 상태가 localStorage에 사람별로 기억된다(AC3)', async () => {
    expandAllGroups();
    await mount();
    const crHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결·규칙'));
    await act(async () => { crHeader!.click(); });

    const stored = JSON.parse(localStorage.getItem('sidebar_group_collapsed') ?? '{}');
    expect(stored['connect-rules']).toBe(true);
  });

  it('기억된 접힘 상태가 마운트 시 그대로 재현된다(기억 있으면 그 값, AC3)', async () => {
    localStorage.setItem('sidebar_group_collapsed', JSON.stringify({ 'connect-rules': true }));
    await mount();
    const channelsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'));
    expect(channelsLink).toBeUndefined();
    const crHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결·규칙'));
    expect(crHeader?.getAttribute('aria-expanded')).toBe('false');
  });

  // story #3762(그라운딩·유나 §定) — 4구역+관리 프레임 전체 높이가 흔한 뷰포트(≤900px)를
  // 넘어서는데 전역 스크롤바 숨김(#2165, globals.css:733-737)까지 겹쳐 신뢰 아래 구역이
  // 스크롤 가능한데도 "없다"로 보였다(그라운딩: org/role 무관 재현, orgMemberships/
  // adminChecked와 무관한 순수 CSS overflow affordance 결함). .scrollbar-visible은
  // globals.css:755의 기존 옵트인(#2528과 동일 패턴) — 새 CSS 없이 클래스만 얹는다.
  it('SidebarContent가 scrollbar-visible 옵트인 클래스를 쓴다(전역 스크롤바 숨김 하 어포던스, 되돌리면 RED)', async () => {
    await mount();
    const content = container.querySelector('[data-slot="sidebar-content"]');
    expect(content?.className).toContain('scrollbar-visible');
  });

  // story #3762 — 딥링크·새로고침으로 신뢰 이후 구역(스크롤해야 보이는 영역)에 바로
  // 들어와도 활성 항목을 찾을 신호가 없었다. channels/page.tsx:1057과 동형 패턴
  // (jsdom 미구현이라 스파이로 호출 자체를 잰다) — block:'nearest'만 검증한다
  // ('start'로 되돌아가면 페이지 전체가 불필요하게 점프하는 회귀).
  it('활성 항목이 있으면 scrollIntoView({block:"nearest"})가 불린다(딥링크 진입 시 활성 항목 자동 노출)', async () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    pathnameRef.current = '/organization/channels';
    expandAllGroups();
    await mount();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

// story #3844(PO 지적 2026-09-14 07:53Z, 캡처 3 라이브 눈확認로 발견) — 「일감」(id 'board')이
// resourceLink('flow') 단일 경로만 알아 WorkspaceFrameTabs가 그 위에 얹은 나머지 탭
// (work-list·sprints·epics·retro·hypotheses)에선 사이드바가 비활성으로 떨어졌다. 처방:
// resourceLink에 WORKSPACE_FRAME_TAB_PATHS(workspace-frame-tabs.tsx SSOT)를
// extraActivePaths로 넘긴다 — 탭을 하나 늘리면 이 판정도 하드코딩 없이 자동으로 늘어난다.
// story #3989(「일감」 흡수 3/N) — 「가설」 탭(경로 hypotheses) 합류로 5→6개.
const EXPECTED_WORKSPACE_FRAME_TAB_PATHS = ['work-list', 'flow', 'sprints', 'epics', 'retro', 'hypotheses'];

describe('AppSidebar — 「일감」 활성 판정은 WorkspaceFrameTabs 경로 SSOT에서 파생(story #3844)', () => {
  // ⭐되돌리면 RED — WorkspaceFrameTabs에 탭이 추가/삭제됐는데 이 표를 안 갱신하면(또는
  // app-sidebar.tsx가 그 SSOT를 다시 안 읽으면) 여기서 먼저 잡힌다. 아래 it.each는 이 표를
  // 하드코딩 소스로 쓰므로, 이 대조 자체가 "표류 감지"의 유일한 자리다.
  it('WORKSPACE_FRAME_TAB_PATHS가 정확히 6개다(work-list·flow·sprints·epics·retro·hypotheses)', async () => {
    const { WORKSPACE_FRAME_TAB_PATHS } = await import('@/components/workspace/workspace-frame-tabs');
    expect(WORKSPACE_FRAME_TAB_PATHS).toEqual(EXPECTED_WORKSPACE_FRAME_TAB_PATHS);
  });

  it.each(EXPECTED_WORKSPACE_FRAME_TAB_PATHS)('/%s 에서 「일감」이 활성(data-active=true)이다', async (path) => {
    pathnameRef.current = `/${path}`;
    expandAllGroups();
    await mount();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.hasAttribute('data-active')).toBe(true);
  });

  it('/chats(일감 밖 화면)에서는 「일감」이 비활성이다', async () => {
    pathnameRef.current = '/chats';
    expandAllGroups();
    await mount();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.hasAttribute('data-active')).toBe(false);
  });
});

// story #3775(카디르 QA 재발견 06:16Z) — 이전 처방(`{userName && <ProfileMenu/>}` → 항상
// 렌더)이 실제로 맞는지 이 파일의 26개 테스트 중 어느 하나도 안 쟀다: 전부 `mount()`가
// userName을 안 넘겨(undefined) 게이팅을 되돌려도 전부 그대로 통과했다 — 사고 재발 지점을
// 아무도 안 잼. 이 스위트가 정확히 그 자리(AppSidebar 레벨에서 userName이 빈 값일 때
// ProfileMenu가 실제로 마운트되는지)를 잰다(profile-menu.test.tsx는 ProfileMenu 단위
// 테스트라 AppSidebar의 호출부 게이팅 자체는 못 잡는다 — 다른 컴포넌트, 다른 갭).
describe('AppSidebar — story #3775 셸 결함(userName 빈 값이어도 ProfileMenu가 항상 렌더된다)', () => {
  // ⭐되돌리면(app-sidebar.tsx가 `{userName && <ProfileMenu .../>}`로 되돌아가면) RED —
  // userName이 undefined일 때 트리거 자체가 안 그려져야 실패한다.
  it('⭐userName을 안 넘기면(undefined) 그래도 ProfileMenu(칩+「이름 설정」)가 렌더된다', async () => {
    expandAllGroups();
    await mount(undefined);
    const trigger = container.querySelector('[data-slot="sidebar-footer"] [data-slot="dropdown-menu-trigger"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain(koMessages.common.memberUnnamed);

    await act(async () => { trigger.click(); });
    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    const setNameItem = Array.from(content!.querySelectorAll('a')).find(
      (a) => a.textContent?.includes(koMessages.accountSwitcher.setName),
    );
    expect(setNameItem).toBeTruthy();
    expect(setNameItem?.getAttribute('href')).toBe('/settings');
  });

  it('userName이 빈 문자열이어도 동형(칩+「이름 설정」)', async () => {
    expandAllGroups();
    await mount('');
    const trigger = container.querySelector('[data-slot="sidebar-footer"] [data-slot="dropdown-menu-trigger"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain(koMessages.common.memberUnnamed);
  });

  it('userName이 있으면(기존 회귀) 「이름 설정」 항목이 없다', async () => {
    expandAllGroups();
    await mount('송윤재');
    const trigger = container.querySelector('[data-slot="sidebar-footer"] [data-slot="dropdown-menu-trigger"]') as HTMLElement;
    expect(trigger.textContent).not.toContain(koMessages.common.memberUnnamed);

    await act(async () => { trigger.click(); });
    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    const setNameItem = Array.from(content!.querySelectorAll('*')).find(
      (el) => el.textContent === koMessages.accountSwitcher.setName,
    );
    expect(setNameItem).toBeFalsy();
  });
});

// story #4003(E-UX-OVERHAUL·셸 통합 2/N) — navV3Flags prop이 실제로 렌더된 href까지
// 전파되는지(nav-config.ts::resolveNavGroups/resolveChatCenterItem 소비 배선 확認).
// 결정 로직 자체(플래그 8조합 표)는 nav-v3-destinations.test.ts·nav-config-v3-flags
// .test.ts가 전담 — 여기선 "prop을 실제로 넘기면 화면이 바뀌는가"만.
describe('AppSidebar — v3 nav 단일 소스(story #4003) 플래그 배선', () => {
  it('⭐navV3Flags 미전달(OFF 기본값) — 지금 develop과 바이트 동일 href', async () => {
    expandAllGroups();
    await mount();
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(todayLink?.getAttribute('href')).toBe('/org-briefing');
  });

  it('todayV3Enabled — 「오늘」 href가 /today로 바뀐다', async () => {
    expandAllGroups();
    await mount(undefined, { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false });
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(todayLink?.getAttribute('href')).toBe('/today');
  });

  it('connectRulesV3Enabled — 연결·규칙 그룹에 통합 항목이 앞에 추가되고 옛 2항목도 그대로 보인다(옛 진입점 유지)', async () => {
    expandAllGroups();
    await mount(undefined, { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true });
    const links = [...container.querySelectorAll('a')];
    const v3Link = links.find((a) => a.getAttribute('href') === '/connect-rules');
    expect(v3Link).toBeDefined();
    expect(links.some((a) => a.getAttribute('href') === '/organization/channels')).toBe(true);
    expect(links.some((a) => a.getAttribute('href') === '/organization/content-rules')).toBe(true);
  });

  // CHANGES(페드루 PO, PR#4386 1차 리뷰) — 「일감」은 어느 단일 플래그에도 안 걸려있어
  // 셋 중 하나만 켜도(여기선 connectRulesV3Enabled) work-list로 전환되는지 확認 —
  // 반대로 셋 다 OFF면 위 「navV3Flags 미전달」 테스트와 동형으로 /flow 그대로.
  it('임의 플래그 하나(connectRulesV3Enabled)만 ON이어도 「일감」이 work-list로 바뀐다(단일 플래그 의존 0)', async () => {
    expandAllGroups();
    await mount(undefined, { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: true });
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.getAttribute('href')).toBe('/work-list');
  });
});

// [SID:4288 · 까디르 4653 P2 재판정] 데스크톱 오프캔버스로 접힌 사이드바 — 내용 칸은 inert지만 ⌘K 팔레트는 열린다(window keydown ·
// 팔레트는 포털이라 inert 밖) · 레일은 inert 밖이라 다시 펼 수 있다.
describe('AppSidebar — 오프캔버스로 접힌 상태에서 ⌘K · 레일([SID:4288])', () => {
  async function mountCollapsed() {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <SidebarProvider defaultOpen={false}>
            <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />
          </SidebarProvider>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('접힘 → 내용 칸 inert · ⌘K로 팔레트가 열리고 inert 밖 · 레일도 inert 밖', async () => {
    stubMatchMedia(); stubFetch(); stubLocalStorage();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    await mountCollapsed();
    expect(container.querySelector('[data-slot="sidebar-content"]')?.hasAttribute('inert')).toBe(true);
    const rail = container.querySelector('[data-sidebar="rail"]');
    expect(rail).not.toBeNull();
    expect(rail!.closest('[inert]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.closest('[inert]')).toBeNull();
  });
});

