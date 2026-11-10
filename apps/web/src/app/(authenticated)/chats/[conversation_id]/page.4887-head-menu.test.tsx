// @vitest-environment jsdom
//
// story 4887 (UI-4 P3-a) — the room head: «two shown + a named ⋯ menu». The mute bell and the notification-settings gear (which had a title but no name) moved into the menu;
// the muted STATE stays visible; «참여자 추가» stays a button.
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

function stubFetch(muteOk: boolean, muted = false, type: 'dm' | 'group' = 'dm') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/conv-1/mute')) {
      return { ok: muteOk, json: async () => ({}) };
    }
    if (url.includes('/api/conversations/conv-1')) {
      return {
        ok: true,
        json: async () => ({
          title: type === 'group' ? '팀 채널' : null, type, muted, last_read_at: null, free_response: false,
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

// story #3759 — ConversationPage가 useToast()로 공유 Context를 구독한다. afterEach의
// vi.resetModules() 때문에 «같은» 새로 뜬 @/components/ui/toast 인스턴스를 함께 동적
// import한다(kanban-board.test.tsx와 동형 처방).
async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');
  function TopBarRenderer() {
    const { title, actions } = useTopBar();
    return <div>{title}{actions}</div>;
  }
  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }
  await act(async () => {
    root.render(wrap(
      <ToastProvider>
        <TopBarProvider>
          <TopBarRenderer />
          <ConversationPage />
        </TopBarProvider>
        <TestToastRenderer />
      </ToastProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}


const triggerOf = () => container.querySelector('[data-testid="room-head-menu"]') as HTMLElement | null;
async function openMenu() {
  await act(async () => { triggerOf()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); triggerOf()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
/** the room head's own action buttons (the TopBarRenderer draws title + actions into the container) */
const headButtons = () => [...container.querySelectorAll('button')].filter((b) => b.closest('[data-testid="chat-view-stub"]') === null);

describe('ConversationPage — the room head menu (story 4887 · UI-4 P3-a)', () => {
  it('⭐ the head shows «참여자 추가» and ONE named «⋯» menu — the bell and the unnamed gear are not on the head any more', async () => {
    stubFetch(true); await mount();
    const names = headButtons().map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).filter(Boolean);
    expect(names).toContain(koMessages.chats.addParticipants);
    expect(triggerOf()?.getAttribute('aria-label')).toBe(koMessages.chats.roomMoreActions); // reverted → the trigger has no name
    expect(container.querySelector('button[aria-label="알림 끄기"]')).toBeNull(); // the bell is inside the menu now
    expect([...container.querySelectorAll('button')].some((b) => b.getAttribute('title') === koMessages.chats.deliveryContractTitle)).toBe(false); // …and so is the gear
  });

  it('⭐ every button on the room head has a name (the gear had only a title)', async () => {
    stubFetch(true); await mount();
    for (const b of headButtons()) {
      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      expect(name, `a head button with no name: ${b.outerHTML.slice(0, 120)}`).not.toBe('');
    }
  });

  it('⭐ the menu holds the two items with their words and the ds icons', async () => {
    stubFetch(true); await mount(); await openMenu();
    const mute = document.querySelector('[data-testid="room-head-mute"]') as HTMLElement;
    const settings = document.querySelector('[data-testid="room-head-settings"]') as HTMLElement;
    expect(mute.textContent).toContain(koMessages.chats.muteNotifications);
    expect(mute.querySelector('[data-icon="notifications_off"]')).not.toBeNull();
    expect(settings.textContent).toContain(koMessages.chats.deliveryContractTitle);
    expect(settings.querySelector('[data-icon="settings"]')).not.toBeNull();
  });

  it('⭐ a muted room shows its state on the head without opening anything — and the menu offers «알림 켜기»', async () => {
    stubFetch(true, true); await mount();
    const indicator = container.querySelector('[data-testid="room-muted-indicator"]');
    expect(indicator).not.toBeNull(); // reverted (state only inside the menu) → null
    expect(indicator!.textContent).toContain(koMessages.chats.notificationsMuted);
    await openMenu();
    const mute = document.querySelector('[data-testid="room-head-mute"]') as HTMLElement;
    expect(mute.textContent).toContain(koMessages.chats.unmuteNotifications);
    expect(mute.querySelector('[data-icon="notifications"]')).not.toBeNull();
  });

  it('a room that is not muted shows no muted state', async () => {
    stubFetch(true, false); await mount();
    expect(container.querySelector('[data-testid="room-muted-indicator"]')).toBeNull();
  });

  it('⭐ choosing «알림 설정» opens the delivery-contract window and closes the menu', async () => {
    stubFetch(true, false, 'group'); await mount(); await openMenu();
    await act(async () => { (document.querySelector('[data-testid="room-head-settings"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector(`[aria-label="${koMessages.chats.deliveryContractFreeResponseLabel}"]`)).not.toBeNull();
    expect(document.querySelector('[data-testid="room-head-settings"]')).toBeNull(); // the menu closed
  });
});
