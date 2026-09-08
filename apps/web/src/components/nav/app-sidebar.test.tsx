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

// story #d986fd6c(IA·S4) — budget=12 확定 뒤 신뢰·지식·조직이 기본 접힘이라, 이 구조적
// 회귀가드들(원래 story #2681)이 전제하던 "항상 전 항목 렌더"가 깨진다. 접힘 기능 자체와
// 무관한 이 테스트들은 접힘 전 상태(구조)를 재는 게 목적이라 localStorage에 전 구역
// 펼침을 미리 심어 둔다 — 접힘 동작 자체는 아래 별도 테스트가 다룬다.
function expandAllGroups() {
  localStorage.setItem('sidebar_group_collapsed', JSON.stringify({ trust: false, knowledge: false, organization: false }));
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

// story #2930(P0-G) I1·I2·I3 처방(doc ia-4zone-redesign-2930) — 「리팩터 전 하드코딩 JSX 정본」
// 전제는 이제 지난 얘기다. 12+메뉴→오늘/워크스페이스/신뢰/지식 4구역+관리(조직·설정) 프레임
// 재편(라우트 전부 불변)+챗을 zone에서 빼 사이드바 챗 center로 승격(I2)+work 존 흐름·스프린트를
// 「보드」 단일 항목으로 접음(I3, PO 스코프 확定 ①=ⓒ 2026-08-22). 스탠드업·회고는 애초 I3에서
// 1차 메뉴 제거를 시도했으나 CI orphan 가드(story #2376)가 막았다 — command-palette에 대체
// entry가 없어 nav서 빼면 진짜 orphan이 됐다(sprints와 달리). 「자동 리듬 표면」(doc B2, 구현
// PO)이 아직 없어 생긴 커플링이라 표면이 설 때까지 nav에 남긴다(②=ⓐ→되돌림, 유나 QA 처방).
// story #a2b004f9(IA·S1, 2026-09-08) — 'work'(zoneWork)가 'dev'(zoneDev)로 개명되고
// content·channel-posts가 신규 'marketing'(zoneMarketing) 구역으로 이관(org-channels·
// org-content-rules·org-insights-board도 조직에서 마케팅으로 합류) — 그룹 소속만 이동,
// 항목 24·모든 라벨·href는 무변(EXPECTED_HREF_BY_LABEL 그대로).
const EXPECTED_GROUPS: Array<{ labelKey: string | null; labels: string[] }> = [
  { labelKey: 'zoneNow', labels: ['조직 브리핑', '알림'] },
  { labelKey: 'zoneDev', labels: ['보드', '목표', '실험실', '스탠드업', '회고'] },
  { labelKey: 'zoneMarketing', labels: ['블로그 포스트', '채널 포스트', '채널 연결', '콘텐츠 규칙', '성과 보드'] },
  { labelKey: 'zoneTrust', labels: ['활동 로그', '신뢰 센터'] },
  { labelKey: 'zoneKnowledge', labels: ['문서', '산출물', '스토리지', '기억'] },
  { labelKey: 'zoneOrganization', labels: ['구성원', '에이전트', '권한', '이벤트', '커넥터'] },
  { labelKey: null, labels: ['설정'] },
];

// 카디르 QA(PR#3100) 지적 — 라벨은 맞는데 href가 다른 항목과 뒤바뀐 뮤테이션은 그룹별 라벨
// 순서 대조(위 EXPECTED_GROUPS)만으론 못 잡는다(라벨 목록 자체는 안 바뀌므로). 20항목(챗
// center 제외 19 + 챗 center 1, 아래 별도 스위트) 전부의 라벨→href 쌍을 개별 대조해 그
// 구멍을 닫는다 — org/project slug 없는 테스트 환경이라 resource 항목은 bare `/${resource}`로
// 폴백한 값(기존 resourceLink()와 동일 규칙). story #2930 — '신뢰'→'신뢰 센터'로 키 갱신
// (org-trust 라벨 개명, href 자체는 불변). I3 — '흐름'+'스프린트'가 '보드'(href는 옛 흐름의
// '/flow' 그대로) 하나로 접혔다. 스탠드업/회고는 CI orphan 가드가 막아 nav에 그대로 남았다
// (위 EXPECTED_GROUPS 주석 참고). story #3179(S3c) — '대시보드'(/dashboard) 항목 자체가
// nav에서 빠져(chat으로 이사·중복 목적지 제거) 챗 제외 19→18항목. story 4180f67f — 조직
// 그룹에 '커넥터'(/organization/connectors) 추가돼 챗 제외 18→19항목. story #3368 — 워크
// 그룹에 '콘텐츠'(/content) 추가돼 챗 제외 19→20항목. story #3376 — 조직 그룹에 '채널'
// (/organization/channels) 추가돼 챗 제외 20→21항목. story #3402 — 워크 그룹에 '채널
// 포스트'(/content/channel-posts) 추가돼 챗 제외 21→22항목. story #3472(페드루 PO
// 확定 2026-09-05) — 조직 그룹에 '콘텐츠 규칙'(/organization/content-rules) 추가돼
// 챗 제외 22→23항목. story #3503 — 조직 그룹에 '성과 보드'(/organization/insights-board)
// 추가돼 챗 제외 23→24항목.
//
// story #ee78b047(IA·S2, 2026-09-08, PO 確定) — 예전엔 '채널 포스트'가 텍스트상 '채널'로
// 시작해 아래 매칭 로직의 startsWith 폴백이 '채널'을 찾을 때 '채널 포스트' 링크를 먼저
// 집을 위험이 있었다(페드루 PO 실측, PR#3768 CI red — exact-match-first로 그때 해소).
// S2가 '채널'을 '채널 연결'로 개명해 그 접두 관계 자체가 이제 없다 — exact-match-first
// 자체는 일반 규율로 그대로 둔다(kbd힌트 항목은 텍스트에 공백 없이 붙어 startsWith가
// 여전히 필요 — '보드'+'B'='보드B', exact 매치가 없어 정상적으로 startsWith로 폴백한다).
const EXPECTED_HREF_BY_LABEL: Record<string, string> = {
  '채널 포스트': '/content/channel-posts',
  '구성원': '/organization/members',
  '에이전트': '/organization/workforce',
  '권한': '/organization/roles',
  '신뢰 센터': '/organization/trust',
  '기억': '/organization/memory',
  '이벤트': '/organization/events',
  '커넥터': '/organization/connectors',
  '채널 연결': '/organization/channels',
  '콘텐츠 규칙': '/organization/content-rules',
  '성과 보드': '/organization/insights-board',
  '조직 브리핑': '/org-briefing',
  '알림': '/inbox',
  '보드': '/flow',
  '목표': '/goals',
  '실험실': '/loops',
  '스탠드업': '/standup',
  '회고': '/retro',
  '블로그 포스트': '/content',
  '활동 로그': '/activity',
  '문서': '/docs',
  '산출물': '/artifacts',
  '스토리지': '/storage',
  '설정': '/settings',
};

describe('AppSidebar — story #2681 NAV_GROUPS 렌더 회귀가드(AC1) + story #2930 I1 4구역 재편', () => {
  it('그룹 순서·라벨·항목 순서·라벨이 IA·S1 확定대로다(오늘→개발→마케팅→신뢰→지식→조직→설정)', async () => {
    expandAllGroups();
    await mount();
    const groupLabels = [...container.querySelectorAll('[data-slot="sidebar-group-label"]')].map((el) => el.textContent);
    expect(groupLabels).toEqual(['오늘', '개발', '마케팅', '신뢰', '지식', '조직']);

    const groups = [...container.querySelectorAll('[data-slot="sidebar-group"]')];
    expect(groups.length).toBe(EXPECTED_GROUPS.length);
    groups.forEach((groupEl, i) => {
      const itemLabels = [...groupEl.querySelectorAll('[data-slot="sidebar-menu-button"] span[data-nav-label]')].map((el) => el.textContent);
      expect(itemLabels).toEqual(EXPECTED_GROUPS[i]!.labels);
    });
  });

  it('정적 항목(조직 그룹)의 href가 무변화다(path 전부 불변, 2930 I1 핵심 제약)', async () => {
    expandAllGroups();
    await mount();
    const membersLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('구성원'));
    expect(membersLink?.getAttribute('href')).toBe('/organization/members');
    const eventsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('이벤트'));
    expect(eventsLink?.getAttribute('href')).toBe('/organization/events');
  });

  it('리소스 항목(개발 그룹, org/project slug 없음)이 bare href로 폴백한다(기존 resourceLink 동작)', async () => {
    await mount();
    // startsWith 유지 — kbd 힌트 접미사가 붙는 항목이 있어 정확한 === 매칭은 못 쓴다.
    const boardLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    expect(boardLink?.getAttribute('href')).toBe('/flow');
  });

  it('kbd 힌트(보드=B·스탠드업=S)가 항목별로 정확히 붙는다', async () => {
    await mount();
    const boardBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    expect(boardBtn?.textContent).toContain('B');
    const standupBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('스탠드업'));
    expect(standupBtn?.textContent).toContain('S');
  });

  // story #9c5e82dc(IA·S3, 유나 § 確定 2026-09-08) — 「프로젝트」 표식은 scope:'project'
  // 9항목에만 붙고, org 11·애매 4(inbox·settings·org-briefing·org-workforce, 카디르 QA
  // 재감사로 2→4 정정)엔 안 붙는다(무표식=org를 뜻하지 않는다 — 이 테스트는 org 대표
  // 표본 하나를 확認한다).
  it('scope:project 항목(보드)엔 「프로젝트」 표식이 붙는다', async () => {
    await mount();
    const boardBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    expect(boardBtn?.textContent).toContain('프로젝트');
  });

  it('org 항목(구성원)엔 「프로젝트」 표식이 안 붙는다', async () => {
    // story #d986fd6c(IA·S4) — 구성원(org-members)이 속한 조직 그룹은 budget=12 기본
    // 접힘 대상이라, 이 테스트(scope 표식 유무 확認, 접힘과 무관)가 항목을 보려면 펼쳐야
    // 한다.
    expandAllGroups();
    await mount();
    const membersBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('구성원'));
    expect(membersBtn?.textContent).not.toContain('프로젝트');
  });

  it('애매 항목(알림·설정)엔 「프로젝트」 표식이 안 붙는다', async () => {
    await mount();
    const inboxBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('알림'));
    expect(inboxBtn?.textContent).not.toContain('프로젝트');
    const settingsBtn = [...container.querySelectorAll('a')].find((a) => a.textContent === '설정');
    expect(settingsBtn?.textContent).not.toContain('프로젝트');
  });

  it('순서는 라벨→표식→kbd다(보드: "보드" 다음 "프로젝트" 다음 "B")', async () => {
    await mount();
    const boardBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    const text = boardBtn?.textContent ?? '';
    const labelIdx = text.indexOf('보드');
    const scopeIdx = text.indexOf('프로젝트');
    const kbdIdx = text.lastIndexOf('B');
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBeGreaterThan(labelIdx);
    expect(kbdIdx).toBeGreaterThan(scopeIdx);
  });

  it('표식은 칩/배지 모양(테두리·배경)을 안 쓴다(유나 § — 성질이지 행위가 아니다)', async () => {
    await mount();
    const boardBtn = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    const scopeEl = [...(boardBtn?.querySelectorAll('span') ?? [])].find((s) => s.textContent === '프로젝트');
    expect(scopeEl).toBeDefined();
    expect(scopeEl?.className).not.toMatch(/border|bg-/);
  });

  it('현재 경로와 일치하는 정적 항목이 active로 표시된다(isActive 판정 보존)', async () => {
    pathnameRef.current = '/organization/events';
    expandAllGroups();
    await mount();
    const eventsBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('이벤트'));
    expect(eventsBtn?.hasAttribute('data-active')).toBe(true);
    const membersBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('구성원'));
    expect(membersBtn?.hasAttribute('data-active')).toBe(false);
  });

  // story #1981 — 배지 소스가 "안 읽은 알림 수"에서 "내 결재 대기 수"로 바뀌었다.
  // story #3084(2026-08-25 층1, PO 확定) — 그 소스가 다시 /api/gates?status=pending&
  // assigned_to_me=true(원시 배열)에서 /api/gates/designated-pending-count({count})로
  // 교체됐다 — designated_approver_id=me AND status=pending만 세는 room-무관 SSOT
  // (BE gates.py::get_designated_pending_count 문서 — "AC1이 이 층에서 닫히는 근거").
  it('결재 대기 배지(inbox)가 카운트>0일 때만 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 3 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await mount();
    const inboxBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('알림'));
    expect(inboxBtn?.textContent).toContain('3');
  });

  it('결재 대기 0건이면 배지가 안 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await mount();
    const inboxBtn = [...container.querySelectorAll('[data-slot="sidebar-menu-button"]')].find((b) => b.textContent?.includes('알림'));
    expect(inboxBtn?.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull();
  });

  it('설정 그룹은 라벨 없는 유틸 그룹으로 유지된다(ia-4zone 확定)', async () => {
    await mount();
    const settingsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('설정') && a.getAttribute('href') === '/settings');
    expect(settingsLink).toBeDefined();
  });

  // 카디르 QA(PR#3100) 지적 — 라벨은 그대로인 채 href만 다른 항목과 뒤바뀌는 뮤테이션은 앞
  // 테스트들(그룹별 라벨 순서 대조 + 4항목만 개별 href 대조)로는 못 잡는다. NAV_GROUPS 20항목
  // (챗 center 자체 href는 별도 스위트에서 대조 — I2로 21→20, I3로 flow+sprints가 board로
  // 접혀 20→19, 스탠드업/회고는 CI orphan 가드로 되돌려 그대로 잔존, story #3179(S3c)로
  // '대시보드' 제거돼 19→18, story 4180f67f로 조직 그룹에 '커넥터' 추가돼 18→19, story #3368로
  // 워크 그룹에 '콘텐츠' 추가돼 19→20) 전부를 라벨→href 쌍으로 개별 대조해 "라벨은 맞는데
  // 목적지가 틀림"을 확실히 막는다.
  it('전 22항목(챗 center 제외)의 라벨→href 쌍이 정확하다(뒤바뀐 목적지 방지, 카디르 QA 지적 반영)', async () => {
    expandAllGroups();
    await mount();
    const links = [...container.querySelectorAll('a')];
    for (const [label, expectedHref] of Object.entries(EXPECTED_HREF_BY_LABEL)) {
      // story #3402(페드루 PO 실측, PR#3768 CI red) — exact match를 먼저 찾고, 없을
      // 때만 startsWith로 폴백한다. kbd 힌트 항목은 텍스트에 공백 없이 붙어("보드"+"B"
      // ="보드B") exact가 안 걸려 여전히 startsWith로 정상 폴백한다. story #ee78b047
      // (IA·S2) 이전엔 '채널 포스트'가 다른 라벨('채널')의 접두어라 exact 우선이 결정적
      // 정확성의 유일한 버팀목이었다 — S2가 '채널'을 '채널 연결'로 개명해 그 접두 관계는
      // 사라졌지만, exact-match-first 자체는 일반 규율로 유지한다.
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

  // story #d986fd6c(IA·S4, PO 確定 2026-09-08) — budget=12(오늘2+개발5+마케팅5) 확定 뒤
  // 기본 상태: 주력 3구역(오늘·개발·마케팅)은 기본 펼침, 2차 구역(신뢰·지식·조직)은 기본
  // 접힘(설정은 애초에 접기 대상 아님).
  it('기본 상태는 주력 3구역(오늘·개발·마케팅) 펼침·2차 구역(신뢰·지식·조직) 접힘이다(budget=12)', async () => {
    await mount();
    const boardLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    expect(boardLink).toBeDefined();
    const contentLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('블로그 포스트'));
    expect(contentLink).toBeDefined();
    const activityLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('활동 로그'));
    expect(activityLink).toBeUndefined();
    const docsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('문서'));
    expect(docsLink).toBeUndefined();
    const orgMembersLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('구성원'));
    expect(orgMembersLink).toBeUndefined();

    const trustHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('신뢰'));
    expect(trustHeader?.getAttribute('aria-expanded')).toBe('false');
    const devHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('개발'));
    expect(devHeader?.getAttribute('aria-expanded')).toBe('true');
  });

  it('구역 헤더를 클릭하면 접히고(항목 DOM에서 사라짐) 다시 클릭하면 펴진다', async () => {
    await mount();
    const devHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('개발'));
    expect(devHeader).toBeDefined();
    expect(devHeader?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { devHeader!.click(); });
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'))).toBeUndefined();
    const devHeaderAfter = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('개발'));
    expect(devHeaderAfter?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { devHeaderAfter!.click(); });
    expect([...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'))).toBeDefined();
  });

  it('접힘 상태가 localStorage에 사람별로 기억된다(AC3)', async () => {
    await mount();
    const devHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('개발'));
    await act(async () => { devHeader!.click(); });

    const stored = JSON.parse(localStorage.getItem('sidebar_group_collapsed') ?? '{}');
    expect(stored.dev).toBe(true);
  });

  it('기억된 접힘 상태가 마운트 시 그대로 재현된다(기억 있으면 그 값, AC3)', async () => {
    localStorage.setItem('sidebar_group_collapsed', JSON.stringify({ dev: true }));
    await mount();
    const boardLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('보드'));
    expect(boardLink).toBeUndefined();
    const devHeader = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('개발'));
    expect(devHeader?.getAttribute('aria-expanded')).toBe('false');
  });

  it('라벨 없는 설정 그룹엔 접기 토글이 없다(헤더 자체가 없음)', async () => {
    await mount();
    const settingsLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '설정');
    expect(settingsLink).toBeDefined();
    const toggles = [...container.querySelectorAll('button[aria-expanded]')];
    expect(toggles.some((b) => b.textContent?.includes('설정'))).toBe(false);
  });
});
