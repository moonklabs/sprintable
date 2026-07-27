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

const { useDashboardContextMock, searchParamsValueRef } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  searchParamsValueRef: { current: '' as string },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// story #2212 — OrgBriefingShell이 이제 useSearchParams(?next= 배너용)를 쓴다. 이 테스트는
// Next 라우터 컨텍스트 밖(createRoot 직접 렌더)이라 목이 없으면 null이 되어 크래시한다.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
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
  searchParamsValueRef.current = '';
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

// story #2212 후속(유나양 카피 판정, 2026-07-27) — 배너 문구는 "이 화면이 활성화됩니다"류
// 시스템어 없이, next 유무로 정확히 갈라야 한다(거짓 문구 방지: next 있는 사람은 실제로
// 다른 곳으로 이동하므로 "여기 표시됩니다"는 그 경우 거짓이다).
describe('OrgBriefingShell — 프로젝트 안내 배너 (story #2212, 유나양 카피 판정)', () => {
  it('?next= 있으면 "원래 보려던 화면으로 이동합니다" 배너(복귀 문구)를 보여준다', async () => {
    searchParamsValueRef.current = 'next=%2Fboard';
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [], projectId: undefined });
    await mount();
    expect(container.textContent).toContain('프로젝트를 선택하면 원래 보려던 화면으로 이동합니다.');
    expect(container.textContent).not.toContain('활성화됩니다');
  });

  it('?next= 없고 프로젝트도 없으면 "여기에 현황이 표시됩니다" 배너(정착 문구)를 보여준다', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [], projectId: undefined });
    await mount();
    expect(container.textContent).toContain('프로젝트를 선택하면 여기에 현황이 표시됩니다.');
  });

  it('?next= 없고 프로젝트가 있으면(평범한 방문) 배너 자체가 안 뜬다(소음 방지)', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [], projectId: 'proj-1' });
    await mount();
    expect(container.textContent).not.toContain('프로젝트를 선택하면');
  });
});
