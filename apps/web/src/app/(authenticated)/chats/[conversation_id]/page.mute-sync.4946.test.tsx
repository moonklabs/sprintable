// @vitest-environment jsdom
//
// story 4946 — the list beside the room flips the room's mute flag from a row menu and announces it (ROOM_MUTED_EVENT): the open room takes the same value (its «muted» mark), for THIS room only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/components/chat/chat-view', () => ({
  ChatView: () => <div data-testid="chat-view-stub" />,
}));

vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
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
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-content', projectMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(muteOk: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/conv-1/mute')) {
      return { ok: muteOk, json: async () => ({}) };
    }
    if (url.includes('/api/conversations/conv-1')) {
      return {
        ok: true,
        json: async () => ({
          title: null, type: 'dm', muted: false, lastReadAt: null, freeResponse: false,
          participants: [
            { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
            { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  const { ToastProvider } = await import('@/components/ui/toast');
  function TopBarRenderer() { const { title, actions } = useTopBar(); return <div>{title}{actions}</div>; }
  await act(async () => { root.render(wrap(<ToastProvider><TopBarProvider><TopBarRenderer /><ConversationPage /></TopBarProvider></ToastProvider>)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('[SID:4946] the room page takes the mute flag the list flipped', () => {
  it('⭐the muted words appear when the list announces THIS room muted, and are not touched by another room\'s announcement', async () => {
    stubFetch(true); await mount();
    expect(container.textContent).not.toContain(koMessages.chats.notificationsMuted);
    const { ROOM_MUTED_EVENT } = await import('@/components/chat/room-muted-event');
    await act(async () => { window.dispatchEvent(new CustomEvent(ROOM_MUTED_EVENT, { detail: { id: 'other-room', muted: true } })); });
    expect(container.textContent).not.toContain(koMessages.chats.notificationsMuted);
    await act(async () => { window.dispatchEvent(new CustomEvent(ROOM_MUTED_EVENT, { detail: { id: 'conv-1', muted: true } })); });
    expect(container.textContent).toContain(koMessages.chats.notificationsMuted); // reverted (no listener) → RED
    await act(async () => { window.dispatchEvent(new CustomEvent(ROOM_MUTED_EVENT, { detail: { id: 'conv-1', muted: false } })); });
    expect(container.textContent).not.toContain(koMessages.chats.notificationsMuted);
  });
});
