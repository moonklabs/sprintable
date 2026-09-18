// @vitest-environment jsdom
//
// story #2865 — 설정 페이지 하단 법적 고지 푸터가 프로필 탭 전용 카드에서 «전 탭 공통
// 하단 푸터»로 승격됐다. 배선이 아니라 «표시를 테스트»한다: profile이 아닌 다른 탭이
// 활성일 때도 이용약관/개인정보처리방침/환불정책+사업자정보가 실제로 렌더되는지, 그리고
// 프로필 탭 안에는 더 이상 중복 렌더가 없는지 화면 결과로 확인한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import enMessages from '../../../../messages/en.json';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=appearance'),
  usePathname: () => '/settings',
}));

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: false, json: async () => ({ data: null }) })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ data: null }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(wrap(node)); });
}

describe('SettingsPage — 전역 법적 고지 푸터 (story #2865)', () => {
  it('profile이 아닌 탭(appearance)이 활성이어도 정책·사업자정보가 렌더된다', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    const text = container.textContent ?? '';
    expect(text).toContain('이용약관');
    expect(text).toContain('개인정보처리방침');
    expect(text).toContain('환불정책');
    expect(text).toContain('주식회사 뭉클랩');

    const anchors = Array.from(container.querySelectorAll('a'));
    const hrefs = anchors.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/terms');
    expect(hrefs).toContain('/privacy');
    expect(hrefs).toContain('/refund-policy');
  });

  it('전역 푸터는 정확히 1벌만 렌더된다 (프로필 탭 중복 제거 확인)', async () => {
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    const termsLinks = Array.from(container.querySelectorAll('a[href="/terms"]'));
    expect(termsLinks).toHaveLength(1);
  });
});

// story #3274(지원v1·후속, 선생님 확定 2026-09-01) — 상시 플로팅 폐기 후 "일반 상황" 유일
// 진입점. isSupportWidgetEnabled() 뒤 게이팅(dev on·prod off, EE_ENABLED와 동일 컨벤션)과
// ?tab=support 딥링크 폴백 둘 다 고정한다.
describe('SettingsPage — story #3274: 설정 > 문의 탭', () => {
  const ORIGINAL_FLAG = process.env['NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED'];

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env['NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED'];
    else process.env['NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED'] = ORIGINAL_FLAG;
  });

  it('flag off(prod 기본값) — 문의 탭 트리거 자체가 없다', async () => {
    delete process.env['NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED'];
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    expect(container.textContent).not.toContain(koMessages.settings.tabSupport);
  });

  it('flag on — 문의 탭 트리거가 뜨고, 클릭하면 위젯 패널(panelTitle)이 인라인 렌더된다', async () => {
    process.env['NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED'] = 'true';
    // 파일 최상단 hoisted mock의 useSearchParams()는 호출마다 `new URLSearchParams(...)`를
    // 새로 만들어 참조가 매 렌더 달라진다 — 실 Next.js useSearchParams()는 네비게이션이
    // 실제로 안 바뀌면 안정적인 참조를 주는데, 이 목은 그렇지 않아 페이지의
    // `useEffect(() => setActiveTab(...), [searchParamsHook])`가 매 렌더 재발화해 클릭으로
    // 바꾼 activeTab을 url의 tab=appearance로 즉시 되돌려버린다(목 아티팩트 — 실 프로덕션
    // 동작이 아님). 이 테스트만 안정 참조로 override.
    const stableParams = new URLSearchParams('tab=appearance');
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => stableParams,
      usePathname: () => '/settings',
    }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    const trigger = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent?.includes(koMessages.settings.tabSupport),
    ) as HTMLElement;
    expect(trigger).not.toBeUndefined();
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain(koMessages.supportWidget.panelTitle);
  });

  it('flag off인데 ?tab=support로 직접 진입해도 기본 탭(profile)으로 폴백한다(빈 화면 방지)', async () => {
    delete process.env['NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED'];
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=support'),
      usePathname: () => '/settings',
    }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    expect(container.textContent).not.toContain(koMessages.supportWidget.panelTitle);
  });
});

// story #3762(그라운딩) — 진짜 결함은 「숨김 탭」이 아니라 adminChecked(/api/me 응답 전)
// 구간에 걸린 비-숨김 admin 탭들(members·organization·projects 등)이 null로 빠져 레일이
// 통째로 짧아지는 것이었다(로딩=권한없음 conflation). loadContext()의 /api/me가 아직
// pending인 순간을 붙잡아 그 구간엔 「자리」(스켈레톤)가 있고, 응답 후에만 진짜 탭/숨김이
// 확정되는지를 잰다.
describe('SettingsPage — story #3762: adminChecked 로딩 vs 권한없음 분리', () => {
  it('/api/me가 아직 pending인 동안 admin 탭 자리에 스켈레톤이 있고 레일이 비지 않는다', async () => {
    let resolveMe: ((res: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') {
        return new Promise((resolve) => { resolveMe = resolve; });
      }
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);

    // /api/me가 아직 안 풀렸다 — adminChecked=false 구간.
    expect(container.querySelectorAll('[data-testid="settings-tab-skeleton"]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(koMessages.settings.tabMembers);

    await act(async () => {
      resolveMe?.({ ok: true, json: async () => ({ data: { role: 'admin', user_id: 'u1' } }) });
      await Promise.resolve(); await Promise.resolve();
    });

    // 판정 후엔 스켈레톤이 걷히고 실제 admin 탭이 선다.
    expect(container.querySelectorAll('[data-testid="settings-tab-skeleton"]').length).toBe(0);
    expect(container.textContent).toContain(koMessages.settings.tabMembers);
  });

  // story #3762 CHANGES(카디르 QA 지적, probe 재현) — loadContext()의 /api/me가
  // reject(네트워크 다운 등)하는 경로는 PR 최초본 테스트가 pending/성공만 덮어 커버 0이었다.
  // try/catch로 isAdmin=false를 잡고 finally로 adminChecked=true를 확정하는 게 코드
  // 계약이라 동작 자체는 정상(스켈레톤이 영원히 안 걷히고, admin 전용 탭만 숨는다)인데
  // 그 경로가 테스트로 고정돼 있지 않았다 — 이 카드의 판정선("스켈레톤이 영원히 안
  // 걷히지 않는다")이 실제로 reject 경로에서도 성립하는지 여기서 잰다.
  it('/api/me가 reject해도(네트워크 다운) 스켈레톤이 걷히고 non-admin 탭은 서고 admin 전용 탭만 숨는다', async () => {
    // story #3762 CHANGES(카디르 QA 재지적) — 이 파일 최상단 mock이 tab=appearance라
    // MyProfileSection(activeTab==='profile'일 때만 마운트, page.tsx:847-849)이 애초
    // 렌더되지 않아, my-profile-section.tsx의 try/catch를 빼는 뮤테이션을 돌려도 이
    // 테스트가 그 파일을 안 재서 그대로 통과했다("이 테스트로 처음 드러난 갭"이라던
    // 앞 회차 커밋 메시지가 부정확했다 — 실제로는 처음부터 그 세 파일을 재지 못했다).
    // tab=profile로 마운트해 MyProfileSection·SetPasswordSection·LinkedAccountsSection
    // 셋 다 실제로 마운트되는 경로에서 reject를 잰다.
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=profile'),
      usePathname: () => '/settings',
    }));
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // MyProfileSection이 실제로 마운트돼(tab=profile) fetchProfile()의 reject 경로가
    // 실행됐는지부터 확認한다 — 이게 없으면 아래 스켈레톤/탭 단언이 통과해도 이
    // 테스트가 my-profile-section.tsx를 안 잰 것일 수 있다.
    expect(fetchWithAuthMock.mock.calls.some((c) => c[0] === '/api/me')).toBe(true);
    expect(container.textContent).toContain(koMessages.settings.tabProfile);

    // 스켈레톤이 영원히 안 걷히지 않는다(finally가 adminChecked=true를 확정).
    expect(container.querySelectorAll('[data-testid="settings-tab-skeleton"]').length).toBe(0);
    // adminChecked만 요구하는 탭(members·organization·projects)은 선다.
    expect(container.textContent).toContain(koMessages.settings.tabMembers);
    expect(container.textContent).toContain(koMessages.settings.tabOrganization);
    // adminChecked && isAdmin을 요구하는 admin 전용 탭은 숨는다(isAdmin=false로 확정).
    expect(container.textContent).not.toContain(koMessages.settings.tabWorkflowPolicies);
    expect(container.textContent).not.toContain(koMessages.settings.tabUsage);
  });

  // story c4980e70이 org-members 탭을 /organization/members로 승격했는데 트리거만
  // HIDDEN_SETTINGS_TABS 가드가 빠져 있었다(story #3762 발견) — 판정 후에도 그 트리거
  // 자체가 렌더되면 안 된다(딥링크는 next.config.ts redirects()가 서버에서 걷어가지만,
  // Settings 안에서 탭 클릭으로는 여전히 도달 가능했던 별도 결함).
  it('adminChecked 후에도 org-members 탭 트리거는 뜨지 않는다(승격 완료, 회귀 pin)', async () => {
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') return Promise.resolve({ ok: true, json: async () => ({ data: { role: 'admin', user_id: 'u1', name: '테스트' } }) });
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain(koMessages.settings.tabOrgMembers);
    // 승격 목적지(조직·프로젝트) 트리거는 정상 렌더 — 가드가 그룹 전체를 과잉 차단하지 않는다.
    expect(container.textContent).toContain(koMessages.settings.tabOrganization);
    expect(container.textContent).toContain(koMessages.settings.tabProjects);
  });
});

// story #3772 — 프로필 탭 섹션 넷(내 프로필·비밀번호·연결된 계정·2FA)이 각자 /api/me를
// 읽다 실패하면 이유 없이 조용히 사라졌다(3762·3768이 만든 결함이 아니라 드러낸 자리).
// 탭 한 자리(배너 1개)에서 사유+재시도를 말하고, 재시도가 섹션 넷을 다시 fetch하게
// 하는지 검증한다.
describe('SettingsPage — story #3772: 프로필 탭 /api/me 실패 배너', () => {
  it('⭐/api/me가 reject하면 상단 배너 1개(사유+재시도) · 섹션마다 중복 배너 0', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=profile'),
      usePathname: () => '/settings',
    }));
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const banners = Array.from(container.querySelectorAll('[role="alert"]')).filter(
      (el) => el.textContent?.includes(koMessages.settings.accountInfoLoadError),
    );
    expect(banners).toHaveLength(1);
    expect(container.textContent).toContain(koMessages.common.retry);
  });

  it('/api/me가 전부 성공이면 배너 0(무변)', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=profile'),
      usePathname: () => '/settings',
    }));
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              id: 'm-1', name: '테스트', email: 't@moonklabs.com', type: 'human', role: 'member',
              has_password: true, linked_providers: [], totp_enabled: false,
            },
          }),
        });
      }
      if (url.startsWith('/api/team-members/')) return Promise.resolve({ ok: true, json: async () => ({ data: { avatar_url: null } }) });
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain(koMessages.settings.accountInfoLoadError);
  });

  it('재시도 클릭 → 섹션 넷이 /api/me를 다시 부른다(리마운트로 재-fetch)', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=profile'),
      usePathname: () => '/settings',
    }));
    const fetchWithAuthMock = vi.fn((url: string) => {
      if (url === '/api/me') return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const callsBeforeRetry = fetchWithAuthMock.mock.calls.filter((c) => c[0] === '/api/me').length;
    expect(callsBeforeRetry).toBeGreaterThan(0);

    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.common.retry,
    ) as HTMLButtonElement;
    expect(retryButton).not.toBeUndefined();
    await act(async () => { retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const callsAfterRetry = fetchWithAuthMock.mock.calls.filter((c) => c[0] === '/api/me').length;
    expect(callsAfterRetry).toBeGreaterThan(callsBeforeRetry);
  });
});

// story #3789 — settings/page.tsx 통짜 한글 30건 슬라이스. 조직 탭·삭제 다이얼로그가
// 실제로 카탈로그 값을 렌더하는지(신설 키 배선)와, 「영구 삭제」 버튼/문장 조각 두 키가
// 서로 다른 값으로 갈렸는지, ICU count 자리표시자가 0/1/복수에서 실제로 치환되는지를 잰다.
describe('SettingsPage — story #3789: 조직 탭·삭제 다이얼로그 i18n 배선', () => {
  function mockOrgFetch(overrides: {
    orgId?: string;
    org?: { id: string; name: string; slug: string; plan?: string; role?: string };
    impact?: { project_count: number; member_count: number; has_active_subscription: boolean } | null;
  } = {}) {
    const orgId = overrides.orgId ?? 'org-1';
    const org = overrides.org ?? { id: orgId, name: '문클랩', slug: 'moonklabs', plan: 'pro', role: 'owner' };
    return vi.fn((url: string) => {
      if (url === '/api/me') return Promise.resolve({ ok: true, json: async () => ({ data: { role: 'admin', user_id: 'u1' } }) });
      if (url === '/api/current-project') return Promise.resolve({ ok: true, json: async () => ({ data: { project_id: 'p1', org_id: orgId } }) });
      if (url === '/api/organizations') return Promise.resolve({ ok: true, json: async () => ({ data: [org] }) });
      if (url === `/api/organizations/${orgId}/impact`) {
        if (overrides.impact === null) return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
        return Promise.resolve({ ok: true, json: async () => ({ data: overrides.impact ?? { project_count: 0, member_count: 0, has_active_subscription: false } }) });
      }
      return Promise.resolve({ ok: false, json: async () => ({ data: null }) });
    });
  }

  async function mountOrgTab(fetchWithAuthMock: ReturnType<typeof mockOrgFetch>) {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=organization'),
      usePathname: () => '/settings',
    }));
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('조직 탭 — 신설 키(섹션 제목·설명·slug 불변 안내·플랜·내 역할)가 실제로 렌더된다', async () => {
    await mountOrgTab(mockOrgFetch());
    const text = container.textContent ?? '';
    expect(text).toContain(koMessages.settings.orgSectionTitle);
    expect(text).toContain(koMessages.settings.orgSectionDescription);
    expect(text).toContain(koMessages.settings.orgSlugImmutable);
    expect(text).toContain(koMessages.settings.orgPlanLabel);
    expect(text).toContain(koMessages.settings.orgMyRoleLabel);
    // 표기 축 — 이 화면에 "Organization"·"Project"·"Member" 영문 명사가 0건.
    expect(text).not.toContain('Organization');
    expect(text).not.toContain('Project ');
    expect(text).not.toContain('Member ');
  });

  it('조직 탭 — Danger Zone 경고문·삭제 버튼이 신설 키를 쓴다(다이얼로그 제목과 같은 키 재사용)', async () => {
    await mountOrgTab(mockOrgFetch());
    const text = container.textContent ?? '';
    expect(text).toContain(koMessages.settings.orgDeleteWarning);
    // 섹션의 삭제 버튼과 다이얼로그 제목이 같은 키(orgDeleteTitle)를 쓴다 — 최소 1회 등장.
    expect(text).toContain(koMessages.settings.orgDeleteTitle);
  });

  it('삭제 다이얼로그 — impact 0건이면 프로젝트/구성원 문장이 count=0으로 렌더된다(ICU 자리표시자 실치환)', async () => {
    await mountOrgTab(mockOrgFetch({ impact: { project_count: 0, member_count: 0, has_active_subscription: false } }));
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.settings.orgDeleteTitle,
    ) as HTMLButtonElement;
    expect(deleteBtn).not.toBeUndefined();
    await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Dialog(components/ui/dialog.tsx)는 DialogPortal로 document.body에 렌더된다 —
    // container 안이 아니라 body 전체를 잰다.
    const text = document.body.textContent ?? '';
    expect(text).toContain('프로젝트 0개 영구 삭제');
    expect(text).toContain('구성원 0명 접근 불가');
    // 활성 구독이 없으면 그 경고문은 안 뜬다.
    expect(text).not.toContain(koMessages.settings.orgDeleteImpactSubscription);
  });

  it('삭제 다이얼로그 — impact 1/다건이면 count가 실제 값으로 치환되고, 활성 구독 경고가 뜬다', async () => {
    await mountOrgTab(mockOrgFetch({ impact: { project_count: 1, member_count: 7, has_active_subscription: true } }));
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.settings.orgDeleteTitle,
    ) as HTMLButtonElement;
    await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const text = document.body.textContent ?? '';
    expect(text).toContain('프로젝트 1개 영구 삭제');
    expect(text).toContain('구성원 7명 접근 불가');
    expect(text).toContain(koMessages.settings.orgDeleteImpactSubscription);
  });

  it('삭제 다이얼로그 — 확인 문구가 조직 이름을 담고, 「영구 삭제」 버튼은 문장 조각(orgDeleteImpactProjects)과 다른 값(orgDeleteConfirmCta)을 쓴다', async () => {
    await mountOrgTab(mockOrgFetch({ org: { id: 'org-1', name: '뭉클랩', slug: 'moonklabs', plan: 'pro', role: 'owner' }, impact: { project_count: 2, member_count: 3, has_active_subscription: false } }));
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.settings.orgDeleteTitle,
    ) as HTMLButtonElement;
    await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const text = document.body.textContent ?? '';
    // 조사 검산 — 받침 있는 이름("뭉클랩")도 문장이 자리표시자를 문장 끝(em dash 뒤)에 둬
    // 조사 없이 성립한다.
    expect(text).toContain('확인을 위해 조직 이름을 그대로 입력하세요 — 뭉클랩');

    // 「영구 삭제」가 두 뜻으로 갈렸다 — 버튼 라벨(orgDeleteConfirmCta)과 문장 조각
    // (orgDeleteImpactProjects)은 서로 다른 카탈로그 값이다.
    expect(koMessages.settings.orgDeleteConfirmCta).not.toBe(koMessages.settings.orgDeleteImpactProjects);
    const confirmDeleteBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.settings.orgDeleteConfirmCta,
    );
    expect(confirmDeleteBtn).not.toBeUndefined();
  });

  // story #3789(페드루 지적 2026-09-10, 유나 r68 실 렌더) — en 값이 ICU plural
  // 미분기라 count=1에도 항상 복수형("1 projects deleted permanently")이 떴다.
  // agents.workflowRuleCount와 동형 ICU plural(one/other)로 정정(ko는 조사/복수
  // 구분이 없어 무변). 이 ns 테스트 파일은 wrap()/mount()가 locale="ko"로 고정돼
  // 있어(위) en 검증은 이 자리만 별도로 NextIntlClientProvider locale="en"을 직접
  // 쓴다.
  describe('삭제 다이얼로그 — en ICU plural(story #3789)', () => {
    function wrapEn(node: React.ReactNode) {
      return (
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
          {node}
        </NextIntlClientProvider>
      );
    }

    async function mountOrgTabEn(fetchWithAuthMock: ReturnType<typeof mockOrgFetch>) {
      vi.doMock('next/navigation', () => ({
        useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
        useSearchParams: () => new URLSearchParams('tab=organization'),
        usePathname: () => '/settings',
      }));
      vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
      const { default: SettingsPage } = await import('./page');
      await act(async () => { root.render(wrapEn(<SettingsPage />)); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    }

    it('count=0 — 복수형("0 projects deleted permanently")', async () => {
      await mountOrgTabEn(mockOrgFetch({ impact: { project_count: 0, member_count: 0, has_active_subscription: false } }));
      const deleteBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === enMessages.settings.orgDeleteTitle,
      ) as HTMLButtonElement;
      await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const text = document.body.textContent ?? '';
      expect(text).toContain('0 projects deleted permanently');
      expect(text).toContain('0 members lose access');
    });

    it('count=1 — 단수형("1 project deleted permanently"·"1 member loses access"), 복수형 문구는 안 뜬다', async () => {
      await mountOrgTabEn(mockOrgFetch({ impact: { project_count: 1, member_count: 1, has_active_subscription: false } }));
      const deleteBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === enMessages.settings.orgDeleteTitle,
      ) as HTMLButtonElement;
      await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const text = document.body.textContent ?? '';
      expect(text).toContain('1 project deleted permanently');
      expect(text).toContain('1 member loses access');
      expect(text).not.toContain('1 projects');
      expect(text).not.toContain('1 members');
    });

    it('count=7(복수) — 복수형("7 projects deleted permanently"·"7 members lose access")', async () => {
      await mountOrgTabEn(mockOrgFetch({ impact: { project_count: 7, member_count: 7, has_active_subscription: false } }));
      const deleteBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === enMessages.settings.orgDeleteTitle,
      ) as HTMLButtonElement;
      await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const text = document.body.textContent ?? '';
      expect(text).toContain('7 projects deleted permanently');
      expect(text).toContain('7 members lose access');
    });
  });

  it('API 키 탭 — 이관 안내가 rich text(<strong>)로 렌더되고, 이동 버튼은 agentManagementCta를 쓴다', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
      useSearchParams: () => new URLSearchParams('tab=api-keys'),
      usePathname: () => '/settings',
    }));
    vi.doMock('@/lib/db/client', () => ({ fetchWithAuth: mockOrgFetch() }));
    const { default: SettingsPage } = await import('./page');
    await mount(<SettingsPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const strongEls = Array.from(container.querySelectorAll('strong'));
    expect(strongEls.some((el) => el.textContent === '에이전트 관리')).toBe(true);
    expect(container.textContent).toContain(koMessages.settings.agentManagementCta);
  });
});
