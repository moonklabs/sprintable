// @vitest-environment jsdom
//
// story 64b9a879 — OrgBriefingShell first-touch 온기 greeting 회귀가드. userName 있으면
// "{name}님, 오늘 조직의 지금이에요" · 없으면(로딩 중 등) 기존 정적 타이틀로 안전 폴백
// ("undefined님" 같은 어색한 렌더 방지).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
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
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { OrgBriefingShell } = await import('./org-briefing-shell');
  await act(async () => { root.render(wrap(<OrgBriefingShell />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('OrgBriefingShell greeting', () => {
  it('userName이 있으면 "{name}님, 오늘 조직의 지금이에요" greeting을 h1로 렌더한다', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [], userName: 'sellerking' });
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('sellerking님, 오늘 조직의 지금이에요');
  });

  it('userName이 없으면(로딩 중 등) 기존 정적 타이틀로 안전 폴백한다 — "undefined님" 렌더 안 함', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [] });
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('조직 브리핑');
    expect(container.innerHTML).not.toContain('undefined');
  });
});
