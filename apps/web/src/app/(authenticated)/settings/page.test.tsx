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
