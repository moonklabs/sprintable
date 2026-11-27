// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · codex round 1) — on a cold load at 390 / 1023 the server (and React's hydrating render) says «not below lg», so the desktop bar's room name used to be published for a moment on a phone. The width has a third answer now (`unknown`):
// the lg-only name is published only when the width is KNOWN to be lg-up. Here the hook is held at each of its three answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, width } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), width: { current: 'unknown' as 'unknown' | 'below-lg' | 'lg-up' } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/chats/conv-1',
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/hooks/use-mobile', async (orig) => ({ ...(await orig<typeof import('@/hooks/use-mobile')>()), useWidthClass: () => width.current }));
vi.mock('@/components/chat/chat-view', () => ({ ChatView: () => <div data-testid="chat-view-stub" /> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1', projectMemberships: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/api/conversations/conv-1')
    ? { ok: true, json: async () => ({ title: '점심 모임', type: 'group', muted: false, last_read_at: null, free_response: false, project_id: 'proj-1', is_project_channel: false, participants: [{ member_id: 'me-1', name: '나', avatar_url: null, type: 'human' }] }) }
    : { ok: true, json: async () => ({ data: [] }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function titleSpanFor(w: 'unknown' | 'below-lg' | 'lg-up') {
  width.current = w;
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  const { ToastProvider } = await import('@/components/ui/toast');
  function Probe() { return <div data-testid="bar-title">{useTopBar().title}</div>; }
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ToastProvider><TopBarProvider><Probe /><ConversationPage /></TopBarProvider></ToastProvider></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  return container.querySelector('[data-testid="bar-title"] > span.text-sm');
}

describe('[SID:5031] ConversationPage — the desktop bar\'s room name waits for a KNOWN width', () => {
  it('⭐unknown (a cold load before the client knows its width): nothing is published for the desktop bar', async () => {
    expect(await titleSpanFor('unknown')).toBeNull();
  });
  it('below-lg: not published (the phone room bar is)', async () => {
    expect(await titleSpanFor('below-lg')).toBeNull();
  });
  it('lg-up: published', async () => {
    expect((await titleSpanFor('lg-up'))?.textContent).toBe('점심 모임');
  });
});
