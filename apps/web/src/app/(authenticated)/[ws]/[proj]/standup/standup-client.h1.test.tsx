// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot의 h1이 그대로 유일한 h1이다.
// 별도 파일인 이유 — standup-client.test.tsx는 TopBarSlot을 `() => null`로 목업해
// (그 파일의 관심사인 missing 격리와 무관) 제목 자체를 안 그린다. 그 공유 목업을
// 건드리면 다른 테스트의 전제가 바뀔 위험이 있어, 이 자리만 실제로 title을 렌더하는
// 별도 목업으로 좁게 새 파일을 둔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));
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

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [{ id: 'sp1', title: '진행중 스프린트', status: 'active', start_date: null, end_date: null }] }) };
    }
    if (url.includes('/api/standup/feedback')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/standup/missing')) return { ok: true, json: async () => ({ data: { missing: [] } }) };
    if (url.includes('/api/stories?project_id=')) return { ok: true, json: async () => ({ data: [], meta: {} }) };
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => { root.render(wrap(<StandupPage projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('StandupClient — 페이지 h1 1개(story #3946)', () => {
  it('⭐h1이 정확히 1개다(TopBarSlot 제목)', async () => {
    stubFetch();
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});
