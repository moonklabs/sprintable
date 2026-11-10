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
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

const { pathnameRef, queryRef } = vi.hoisted(() => ({ pathnameRef: { current: '/dashboard' }, queryRef: { current: '' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(queryRef.current),
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
    org: false,
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
  queryRef.current = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(userName?: string, navV3Flags?: NavV3Flags) {
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
// story #4885(UI-2 AC4 PR 1) — 새 구조: 매일 다섯 + 접힌 «조직» + 설정 + «전체». 「더보기」 서랍은 걷혔고 «연결·규칙» 구역도 없다(채널 연결 · 연산 커넥터 · 콘텐츠 규칙은 «조직» 안).
// 이 테스트는 expandAllGroups로 «조직»을 펴고 잰다(기본은 접힘 — 전용 케이스가 따로 잠근다).
const EXPECTED_GROUPS: Array<{ labelKey: string | null; labels: string[] }> = [
  { labelKey: null, labels: ['홈', '결재'] },
  { labelKey: null, labels: ['일감', '목표', '실행'] },
  { labelKey: 'zoneTeam', labels: ['구성원', '에이전트', '실행 기록', 'API 키'] },
  { labelKey: 'zoneKnowledge', labels: ['문서', '산출물', '스토리지'] },
  { labelKey: 'zoneOrganization', labels: ['결과', '채널 연결', '연산 커넥터', '콘텐츠 규칙', '레시피', '신뢰 센터', '권한', '활동 로그', '블로그 포스트', '채널 포스트'] },
  { labelKey: null, labels: ['설정'] },
  { labelKey: null, labels: ['전체'] },
];

// 카디르 QA(PR#3100) 지적 — 라벨은 맞는데 href가 다른 항목과 뒤바뀐 뮤테이션은 그룹별 라벨
// 순서 대조(위 EXPECTED_GROUPS)만으론 못 잡는다. 5항목(챗 center 제외 4 + 챗 center 1,
// 아래 별도 스위트) 전부의 라벨→href 쌍을 개별 대조해 그 구멍을 닫는다.
// story #4003 — flag OFF(이 스위트의 기본 렌더 조건, navV3Flags 미전달)에서 5항목
// 전부 지금 develop과 바이트 동일(회귀 0). 「일감」의 flag-aware work-list 전환은
// 별도 describe(하단 "v3 nav 단일 소스" 스위트)가 ON 케이스로 검증.
const EXPECTED_HREF_BY_LABEL: Record<string, string> = {
  '홈': '/org-briefing',
  '결재': '/inbox?tab=gates',
  '일감': '/flow',
  '구성원': '/organization/members',
  '에이전트': '/organization/workforce',
  '실행 기록': '/organization/workforce/runs',
  'API 키': '/organization/workforce/api-keys',
  '문서': '/docs',
  '결과': '/organization/insights-board',
  '설정': '/settings',
  '전체': '/more',
  '채널 연결': '/organization/channels',
  '연산 커넥터': '/organization/generation-connectors',
  '콘텐츠 규칙': '/organization/content-rules',
};

describe('AppSidebar — story #3824 → #4885 새 구조 렌더 회귀가드(매일 다섯 + 조직 + 설정 + 전체)', () => {
  it('그룹 순서·라벨·항목 순서·라벨이 확定대로다(오늘 → 일감 → 팀 → 지식 → 조직 → 설정 → 전체)', async () => {
    expandAllGroups();
    await mount();
    // 헤더리스 그룹(오늘·일감·설정·전체)은 sidebar-group-label 자체가 없다 — 라벨 그룹은 「팀」 「지식」 「조직」.
    const groupLabels = [...container.querySelectorAll('[data-slot="ds-section-header"] button')].map((el) => el.textContent);
    expect(groupLabels).toEqual(['팀', '지식', '조직']);

    const groups = [...container.querySelectorAll('[data-slot="sidebar-group"]')];
    expect(groups.length).toBe(EXPECTED_GROUPS.length);
    groups.forEach((groupEl, i) => {
      const itemLabels = [...groupEl.querySelectorAll('[data-slot="ds-list-row"] span[data-nav-label]')].map((el) => el.textContent);
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
    const todayIndex = links.findIndex((a) => a.textContent?.includes('홈'));
    const chatsIndex = links.findIndex((a) => a.textContent?.includes('대화'));
    const workIndex = links.findIndex((a) => a.textContent?.includes('일감'));
    expect(todayIndex).toBeGreaterThanOrEqual(0);
    expect(chatsIndex).toBeGreaterThanOrEqual(0);
    expect(workIndex).toBeGreaterThanOrEqual(0);
    expect(todayIndex).toBeLessThan(chatsIndex);
    expect(chatsIndex).toBeLessThan(workIndex);
  });

  it('정적 항목(조직 묶음)의 href가 무변화다(path 전부 불변)', async () => {
    expandAllGroups();
    await mount();
    const channelsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'));
    expect(channelsLink?.getAttribute('href')).toBe('/organization/channels');
    const rulesLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('콘텐츠 규칙'));
    expect(rulesLink?.getAttribute('href')).toBe('/organization/content-rules');
  });

  it('story #4524 — «데스크톱 앱» links to /desktop only when the server says DESKTOP_DOWNLOAD_ENABLED (no role input: everyone sees it)', async () => {
    const desktopLink = () => [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('데스크톱 앱'));
    expandAllGroups();
    await mount(undefined, { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false, desktopDownloadEnabled: true });
    expect(desktopLink()?.getAttribute('href')).toBe('/desktop');
    await mount(undefined, { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false, desktopDownloadEnabled: false });
    expect(desktopLink()).toBeUndefined();
  });

  it('리소스 항목(일감, org/project slug 없음)이 bare href로 폴백한다(기존 resourceLink 동작)', async () => {
    expandAllGroups();
    await mount();
    // startsWith 유지 — kbd 힌트 접미사가 붙는 항목이 있어 정확한 === 매칭은 못 쓴다.
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.getAttribute('href')).toBe('/flow');
  });

  it('⭐받는 곳 없는 kbd 힌트(일감 «B»)는 그리지 않는다(story #4885 · 단축키 표시 정직) — 일감 줄엔 「프로젝트」 표식만', async () => {
    expandAllGroups();
    await mount();
    const workBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workBtn?.textContent).toBe('일감프로젝트');
    expect(workBtn?.querySelector('kbd')).toBeNull();
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
    const todayBtn = [...container.querySelectorAll('a')].find((a) => a.textContent === '홈');
    expect(todayBtn?.textContent).not.toContain('프로젝트');
  });

  it('순서는 라벨→표식이다(일감: "일감" 다음 "프로젝트") — kbd는 실제 단축키가 있을 때만 그 뒤에 붙는다(지금은 없음)', async () => {
    expandAllGroups();
    await mount();
    const workBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    const text = workBtn?.textContent ?? '';
    expect(text.indexOf('일감')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('프로젝트')).toBeGreaterThan(text.indexOf('일감'));
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
    const channelsBtn = [...container.querySelectorAll('[data-slot="ds-list-row"]')].find((b) => b.textContent?.includes('채널 연결'));
    expect(channelsBtn?.getAttribute('aria-current')).toBe('page');
    const rulesBtn = [...container.querySelectorAll('[data-slot="ds-list-row"]')].find((b) => b.textContent?.includes('콘텐츠 규칙'));
    expect(rulesBtn?.getAttribute('aria-current')).toBeNull();
  });

  // story #1981/#3084 배지 축 — story #4885에서 'inbox' 항목이 «결재»라는 이름으로 사이드바에 돌아왔다(폰 «결재» 탭과 같은 이름 · 같은 착지 · 같은 배지: 내가 지정된 대기 결재 수).
  it('결재 대기 카운트가 있으면 «결재» 항목(만)에 배지가 붙는다', async () => {
    expandAllGroups();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 3 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await mount();
    const badges = [...container.querySelectorAll('[data-slot="ds-count-badge"]')];
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest('[data-slot="sidebar-menu-item"]')?.textContent).toContain('결재');
  });

  it('헤더리스 그룹(오늘·일감·설정)엔 접기 토글이 없다(옛 설정 그룹과 동형 관례)', async () => {
    await mount();
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '홈');
    expect(todayLink).toBeDefined();
    const toggles = [...container.querySelectorAll('button[aria-expanded]')];
    expect(toggles.some((b) => b.textContent?.includes('홈'))).toBe(false);
    expect(toggles.some((b) => b.textContent?.includes('일감'))).toBe(false);
    expect(toggles.some((b) => b.textContent?.includes('설정'))).toBe(false);
  });

  // 카디르 QA(PR#3100) 지적 — 라벨은 그대로인 채 href만 다른 항목과 뒤바뀌는 뮤테이션은 앞
  // 테스트들로는 못 잡는다. 5항목(챗 center 제외) 전부를 라벨→href 쌍으로 개별 대조.
  it('전 항목(챗 center 제외)의 라벨→href 쌍이 정확하다(뒤바뀐 목적지 방지, 카디르 QA 지적 반영)', async () => {
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
    const todayLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '홈');
    expect(todayLink).toBeDefined();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink).toBeDefined();
    // 구역 토글 버튼만 좁혀서 잰다 — 컨테이너 전체 button[aria-expanded]는 다른 컴포넌트
    // (드롭다운·스위처 등)의 닫힌 트리거도 걸려 오탐한다. story #4885 — 「조직」은
    // 이 f81657f8 규칙 밖의 별도 기본값(기본 접힘)이라 이 대조에서 뺀다(아래 전용 케이스가 따로 잠근다).
    const toggles = [...container.querySelectorAll('[data-slot="ds-section-header"] button')]
      .filter((b) => b.textContent !== '조직');
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggles.every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true);
  });

  it('⭐«조직»은 기본 접힘이다(항목이 DOM에 없음 · aria-expanded=false) — 사람이 펼치면 기억되고, 지금 화면이 그 안이면 열려 있다', async () => {
    await mount();
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'))).toBeUndefined();
    const orgHeader = [...container.querySelectorAll('[data-slot="ds-section-header"] button')].find((b) => b.textContent === '조직');
    expect(orgHeader?.getAttribute('aria-expanded')).toBe('false');
    // 지금 화면이 «조직» 안(채널 연결)이면 기억이 접힘이어도 열려 있다 — 현재 위치가 사라지지 않는다.
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pathnameRef.current = '/organization/channels';
    await mount();
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.includes('채널 연결'))).toBeDefined();
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
      // story #4885 — 「조직」은 이 회귀가드 밖(별도 기본값: 접힘), 위 테스트와 동일 이유로 제외.
      const toggles = [...container.querySelectorAll('[data-slot="ds-section-header"] button')]
        .filter((b) => b.textContent !== '조직');
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
    const header = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('지식'));
    expect(header()).toBeDefined();
    expect(header()?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { header()!.click(); });
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.includes('산출물'))).toBeUndefined();
    expect(header()?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { header()!.click(); });
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.includes('산출물'))).toBeDefined();
  });

  // 접힘 상태는 aria-expanded로, 접근 가능한 이름은 그룹명 그대로(SectionHeader 단추 — 이름에 «접기/펼치기»를 또 싣지 않는다).
  it('구역 토글 단추: 이름 = 그룹명, 접힘 상태는 aria-expanded', async () => {
    await mount();
    const header = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('지식'));
    expect(header()?.getAttribute('aria-expanded')).toBe('true');
    expect(header()?.getAttribute('aria-label')).toBeNull();
    expect(header()?.textContent?.trim()).toBe('지식');

    await act(async () => { header()!.click(); });
    expect(header()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('접힘 상태가 localStorage에 사람별로 기억된다(AC3)', async () => {
    await mount();
    const header = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('지식'));
    await act(async () => { header!.click(); });

    const stored = JSON.parse(localStorage.getItem('sidebar_group_collapsed') ?? '{}');
    expect(stored['knowledge']).toBe(true);
  });

  it('기억된 접힘 상태가 마운트 시 그대로 재현된다(기억 있으면 그 값, AC3)', async () => {
    localStorage.setItem('sidebar_group_collapsed', JSON.stringify({ knowledge: true }));
    await mount();
    const docsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('산출물'));
    expect(docsLink).toBeUndefined();
    const header = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('지식'));
    expect(header?.getAttribute('aria-expanded')).toBe('false');
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

  it.each(EXPECTED_WORKSPACE_FRAME_TAB_PATHS)('/%s 에서 「일감」이 활성(aria-current=page)이다', async (path) => {
    pathnameRef.current = `/${path}`;
    expandAllGroups();
    await mount();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.getAttribute('aria-current')).toBe('page');
  });

  it('/chats(일감 밖 화면)에서는 「일감」이 비활성이다', async () => {
    pathnameRef.current = '/chats';
    expandAllGroups();
    await mount();
    const workLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('일감'));
    expect(workLink?.getAttribute('aria-current')).toBeNull();
  });
});

// story #4885 (codex 1판) — 정적 항목의 «지금 여기»는 가장 구체적인 하나만 켠다 · 항목 경로의 쿼리(?tab=gates)는 지금 주소의 쿼리와 맞아야 켠다.
describe('AppSidebar — 지금 여기 판정(story #4885)', () => {
  const activeLabels = () => [...container.querySelectorAll('[data-slot="ds-list-row"][aria-current="page"]')].map((b) => b.querySelector('span[data-nav-label]')?.textContent);

  it('⭐쿼리 달린 항목: /inbox?tab=gates에서 «결재»가 켜지고, 같은 /inbox의 알림 탭에서는 꺼진다', async () => {
    expandAllGroups();
    pathnameRef.current = '/inbox';
    queryRef.current = 'tab=gates';
    await mount();
    expect(activeLabels()).toEqual(['결재']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryRef.current = 'tab=notifications';
    await mount();
    // 같은 화면의 다른 탭 — 정확히 맞는 항목이 없으니 이 화면의 항목(결재)이 위치를 알려 준다(예전엔 켜진 항목 0).
    expect(activeLabels()).toEqual(['결재']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryRef.current = '';
    await mount();
    expect(activeLabels(), '탭 없는 /inbox(기본 탭 «알림»)').toEqual(['결재']);
  });

  it('⭐접두가 겹치는 형제: /organization/workforce/runs에서 «실행 기록»만 켜진다(에이전트는 꺼짐) — /content/channel-posts도 «채널 포스트»만', async () => {
    expandAllGroups();
    pathnameRef.current = '/organization/workforce/runs';
    await mount();
    expect(activeLabels()).toEqual(['실행 기록']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pathnameRef.current = '/content/channel-posts';
    await mount();
    expect(activeLabels()).toEqual(['채널 포스트']);
  });

  it('상세 화면은 부모 항목을 켠다(/organization/workforce/abc → «에이전트») · «전체»는 /more에서만', async () => {
    expandAllGroups();
    pathnameRef.current = '/organization/workforce/abc';
    await mount();
    expect(activeLabels()).toEqual(['에이전트']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pathnameRef.current = '/more';
    await mount();
    expect(activeLabels()).toEqual(['전체']);
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

// story #4885(UI-2 AC4 PR 1) — 새 셸은 플래그 없이 하나다: v3 플래그를 켜도 사이드바의 «오늘» · «일감» · «연결·규칙»은 바뀌지 않는다(정본 = 지금 서 있는 화면, v3 쪽은 켜지도 떼지도 않는다).
// 플래그로 달라지는 것은 «데스크톱 앱» 항목 하나(그 화면이 꺼지면 되돌려 보내므로 — 위 story #4524 케이스)뿐이다.
describe('AppSidebar — 새 셸은 플래그 없이 하나(story #4885)', () => {
  it('⭐v3 플래그를 전부 켜도 «오늘» · «일감» · «대화» href는 그대로다(/org-briefing · /flow · /chats)', async () => {
    expandAllGroups();
    await mount(undefined, { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true });
    const links = [...container.querySelectorAll('a')];
    expect(links.find((a) => a.textContent === '홈')?.getAttribute('href')).toBe('/org-briefing');
    expect(links.find((a) => a.textContent?.startsWith('일감'))?.getAttribute('href')).toBe('/flow');
    expect(links.find((a) => a.textContent?.includes('대화'))?.getAttribute('href')).toBe('/chats');
    expect(links.some((a) => a.getAttribute('href') === '/connect-rules' || a.getAttribute('href') === '/today' || a.getAttribute('href') === '/work-list')).toBe(false);
  });

  it('⭐플래그를 안 넘겨도(기본) 켜도 같은 항목 순서다', async () => {
    expandAllGroups();
    await mount();
    const off = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    expandAllGroups();
    await mount(undefined, { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true });
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(off);
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


// story #4885 (AC3 §5) — ⌘K 팔레트의 «이동» 순서는 길잡이가 실제로 그린 순서와 같다. 기대 순서를 손으로도 설정 파생으로도 적지 않고, 길잡이 DOM이 그린 줄 순서를 직접 읽어 비교한다.
// 길잡이에만 있는 항목(데스크톱 앱 — 팔레트엔 안 싣는 것이 4524로 고정)과 팔레트에만 있는 항목(일감 탭 앵커 · 그 밖)은 비교에서 뺀다.
describe('AppSidebar — 줄 순서가 ⌘K 팔레트 «이동» 순서와 같다(story #4885)', () => {
  it('⭐길잡이가 그린 [data-nav-id] 순서 = 팔레트 이동 목록에서 길잡이에 있는 항목만 거른 순서', async () => {
    expandAllGroups();
    await mount();
    const { deriveNavigateItems } = await import('@/components/command-palette/command-palette');
    const sidebarIds = [...container.querySelectorAll('[data-nav-id]')].map((el) => el.getAttribute('data-nav-id')!);
    expect(sidebarIds.length).toBeGreaterThan(10);
    const paletteIds = deriveNavigateItems((resource) => `/ws/proj/${resource}`).map((item) => item.id);
    const inSidebar = new Set(sidebarIds);
    expect(paletteIds.filter((id) => inSidebar.has(id))).toEqual(sidebarIds.filter((id) => paletteIds.includes(id)));
    // 길잡이에 있는 건 전부 팔레트에도 있다(데스크톱 앱만 예외 — 켜진 곳에서만 길잡이에 선다).
    expect(sidebarIds.filter((id) => !paletteIds.includes(id)).filter((id) => id !== 'desktop-app')).toEqual([]);
    // 대화 카드는 첫 구역(홈 · 결재) 바로 뒤, 일감보다 앞이다.
    expect(sidebarIds.indexOf('chats')).toBe(sidebarIds.indexOf('inbox') + 1);
    expect(sidebarIds.indexOf('chats')).toBeLessThan(sidebarIds.indexOf('board'));
  });
});
