// @vitest-environment jsdom
//
// [SID:4374] 390 작업 목록 시트 머리에 «✕»가 둘(시트 기본 닫기 + 안쪽 상세 패널 닫기 · 둘 다 접근 이름 «닫기») → 시트 안 닫기는 하나.
// 누르면 선택 해제(= 시트와 상세가 함께 닫힘) · Esc 한 번 = 같은 동작. 1440 aside의 패널 닫기는 그대로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import type { FetchedWorkList } from './fetch-work-list';

const { fetchWorkListMock, replaceMock, mobileRef } = vi.hoisted(() => ({
  fetchWorkListMock: vi.fn<(projectId: string) => Promise<FetchedWorkList>>(),
  replaceMock: vi.fn<(href: string) => void>(),
  mobileRef: { current: true },
}));

vi.mock('./fetch-work-list', () => ({ fetchWorkList: (projectId: string) => fetchWorkListMock(projectId) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('row=t1'),
  usePathname: () => '/work-list',
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useParams: () => ({ ws: 'moonklabs', proj: 'sprintable' }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobileRef.current }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function payload(): FetchedWorkList {
  return {
    workList: {
      groups: [{
        goalId: 'g1', title: '목표', isActive: true, doneCount: 0, totalCount: 1, assignedCount: 1, delegatedCount: 0, hypothesisCount: 0,
        stories: [{
          storyId: 's1', title: '스토리', status: 'in-progress', hypothesisIds: [],
          rows: [{ id: 't1', kind: 'task', workItemType: 'task', workItemId: 't1', title: '할일1', ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: null }],
        }],
      }],
      partial: false,
      totalStoryCount: 1,
    },
    hypotheses: [],
  };
}

async function mount() {
  const { WorkListShell } = await import('./work-list-shell');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><WorkListShell projectId="p1" /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

const CLOSE = koMessages.common.close;
const closeButtons = (scope: ParentNode) => Array.from(scope.querySelectorAll<HTMLElement>('button')).filter((b) => {
  const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
  return name === CLOSE || name === koMessages.workList.panelClose;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWorkListMock.mockReset();
  fetchWorkListMock.mockResolvedValue(payload());
  replaceMock.mockReset();
  mobileRef.current = true;
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('[SID:4374] 390 작업 목록 시트 — 닫기 하나', () => {
  it('시트 안 «닫기» 단추 = 1 · 누르면 선택 해제(시트 + 상세 함께 닫힘)', async () => {
    await mount();
    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.querySelector('[data-testid="work-list-detail-panel"]')).not.toBeNull();
    const closes = closeButtons(sheet!);
    expect(closes.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toHaveLength(1);
    expect(sheet!.querySelector('[data-slot="sheet-close"]')).toBeNull();
    await act(async () => { closes[0]!.click(); });
    expect(replaceMock).toHaveBeenCalledWith('/work-list');
  });

  it('Esc 한 번 = 같은 동작(선택 해제)', async () => {
    await mount();
    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!;
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await act(async () => { sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(replaceMock).toHaveBeenCalled();
    expect(new Set(replaceMock.mock.calls.map((c) => c[0]))).toEqual(new Set(['/work-list']));
  });

  it('1440(곁 패널): 시트 없음 · 패널 닫기 그대로 하나', async () => {
    mobileRef.current = false;
    await mount();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    const aside = document.querySelector<HTMLElement>('aside[data-work-list-detail]')!;
    expect(closeButtons(aside)).toHaveLength(1);
  });
});
