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
