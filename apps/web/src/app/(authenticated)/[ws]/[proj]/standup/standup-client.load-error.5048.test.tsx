// @vitest-environment jsdom
//
// story 5048 ⑤ (③a) — 스탠드업을 못 불러오면(영역 전체) ds ErrorState가 뜨고, 「다시 시도」는 다시 읽어 성공하면 오류가 사라진다(옛: 테두리 상자 안 EmptyState + hero 단추).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-board-card', () => ({ StandupBoardCard: () => null }));
vi.mock('@/components/standup/standup-feedback-dialog', () => ({ StandupFeedbackDialog: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(opts: { missingReject?: boolean; entries?: unknown[]; members?: unknown[]; stories?: unknown[]; entriesReject?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/standup?date=')) { if (opts.entriesReject) throw new Error('network down'); return { ok: true, json: async () => ({ data: opts.entries ?? [] }) }; }
    if (false) return { ok: true, json: async () => ({ data: opts.entries ?? [] }) };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: opts.members ?? [] }) };
    if (url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [{ id: 'sp1', title: '진행중 스프린트', status: 'active', start_date: null, end_date: null }] }) };
    }
    if (url.includes('/api/standup/feedback')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/standup/missing')) {
      if (opts.missingReject) throw new Error('network down');
      return { ok: true, json: async () => ({ data: [] }) };  // story #4298 — BE `[{id, name}]`(BFF가 data로 감쌈)
    }
    if (url.includes('/api/stories?project_id=')) {
      return { ok: true, json: async () => ({ data: opts.stories ?? [], meta: {} }) };
    }
    // [SID:4311 PR 3] 스토리마다 일 진척 요약(없으면 목록 로드가 실패로 끝난다).
    if (url.includes('/api/tasks?story_id=')) return { ok: true, json: async () => ({ data: [], meta: { totalCount: 0, doneCount: 0 } }) };
    return { ok: false, json: async () => null };
  }));
}

async function mount(props: { embedded?: boolean } = {}) {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => { root.render(wrap(<StandupPage projectId="proj-1" {...props} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}


describe('StandupClient — 불러오기 실패는 ds ErrorState + 다시 시도(story 5048 ⑤)', () => {
  it('⭐읽기가 실패하면 ErrorState(role=alert · 제목 = 불러오지 못했어요 · 설명)가 뜨고, 「다시 시도」를 누르면 다시 읽어 성공하면 사라진다', async () => {
    stubFetch({ entriesReject: true });
    await mount();
    const err = container.querySelector('[data-slot="ds-error-state"]') as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain(koMessages.standup.loadFailed);
    expect(err.textContent).toContain(koMessages.standup.loadFailedDescription);
    const retry = [...err.querySelectorAll('button')].find((b) => b.textContent === koMessages.standup.retry) as HTMLButtonElement;
    expect(retry).toBeDefined();
    expect(retry.className).toContain('h-ds-control-sm'); // ds Button(40) — 옛 hero 단추가 아니다
    stubFetch(); // the server is back
    await act(async () => { retry.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-slot="ds-error-state"]')).toBeNull();
    expect(container.textContent).toContain('진행중 스프린트');
  });
});
