// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — missingRes(부수, "실패해도 본 화면은
// 막지 않음" 주석)가 sprintsRes/feedbackRes(주)와 같은 미격리 Promise.all 안에 있어,
// missingRes의 fetch 자체가 네트워크단 reject하면 주 데이터 둘도 같이 못 얻던 결함의
// 회귀가드. 전체 기능 스위트가 아니라 이 격리 하나만 좁게 검증한다.
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

function stubFetch(opts: { missingReject?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [{ id: 'sp1', title: '진행중 스프린트', status: 'active', start_date: null, end_date: null }] }) };
    }
    if (url.includes('/api/standup/feedback')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/standup/missing')) {
      if (opts.missingReject) throw new Error('network down');
      return { ok: true, json: async () => ({ data: { missing: [] } }) };
    }
    if (url.includes('/api/stories?project_id=')) {
      return { ok: true, json: async () => ({ data: [], meta: {} }) };
    }
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => { root.render(wrap(<StandupPage projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('StandupClient — missing 격리(story #3519)', () => {
  it('missing이 네트워크 reject해도 활성 스프린트(주 데이터)는 그대로 뜬다(loadError 없음)', async () => {
    stubFetch({ missingReject: true });
    await mount();
    expect(container.textContent).toContain('진행중 스프린트');
    expect(container.textContent).not.toContain(koMessages.standup.loadFailed);
  });
});
