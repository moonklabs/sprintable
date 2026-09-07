// @vitest-environment jsdom
//
// story #3637(유나 silent-failure-sweep-3632, doc 자리 ③) — voteItem이 실패하면 체크가
// 조용히 해제되던 자리(문구 0). 카탈로그에 이미 있던(어디서도 안 쓰이던) voteFailed
// 키를 배선한다(새 키 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
}));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(RetroRouteProvider: React.ComponentType<{ wsSlug: string; projSlug: string; projectId: string; children: React.ReactNode }>, node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RetroRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1">
        {node}
      </RetroRouteProvider>
    </NextIntlClientProvider>
  );
}

const SESSION = {
  id: 'session-1', project_id: 'proj-1', title: '회고 1', phase: 'vote', sprint_id: null,
  items: [{ id: 'item-1', category: 'good', text: '아이템 1', vote_count: 0, voted_by_me: false }],
  actions: [],
};

function stubFetch(voteOk: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes(`/api/retro-sessions/${SESSION.id}?project_id=`)) {
      return { ok: true, json: async () => ({ data: SESSION }) };
    }
    if (typeof url === 'string' && url.includes('/vote?project_id=') && init?.method === 'POST') {
      return { ok: voteOk, json: async () => ({}) };
    }
    if (typeof url === 'string' && url.includes('/api/team-members')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', currentTeamMemberId: 'member-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: RetroSessionPage } = await import('./page');
  const { RetroRouteProvider } = await import('../retro-context');
  await act(async () => { root.render(wrap(RetroRouteProvider, <RetroSessionPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('RetroSessionPage — 투표 실패 시 문장(story #3637)', () => {
  it('voteItem 실패 시 voteFailed 토스트가 뜬다(구 조용한 체크 해제)', async () => {
    stubFetch(false);
    await mount();
    const voteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.retro.vote);
    await act(async () => { voteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.retro.voteFailed);
  });

  // 뮤테이션 대표 — 성공 시엔 토스트가 안 뜨고 "투표 완료"로 바뀐다(과보고 방지).
  it('voteItem 성공 시엔 토스트가 안 뜨고 투표 완료로 바뀐다', async () => {
    stubFetch(true);
    await mount();
    const voteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.retro.vote);
    await act(async () => { voteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.retro.voteFailed);
    expect(container.textContent).toContain(koMessages.retro.alreadyVoted);
  });
});
