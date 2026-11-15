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
  // The popup opens in a first frame marked `data-starting-style` (the library's opening transition). An item pressed INSIDE that frame is dropped: the item's own handler runs, the library's close does not — the settings test then saw the window open and the menu still open, in 6 whole-file runs of 6 on a fast machine (0 of 6 once the click came 100 ms later; a person cannot press an item in the first frame). Wait for the popup to have left that frame — a state, not a time.
  await vi.waitFor(() => {
    const popup = document.querySelector('[role=menu]');
    expect(popup, 'the menu popup is there').not.toBeNull();
    expect(popup!.hasAttribute('data-starting-style'), 'the popup has left its opening frame').toBe(false);
  });
}
/** the room head's own action buttons (the TopBarRenderer draws title + actions into the container) */
const headButtons = () => [...container.querySelectorAll('button')].filter((b) => b.closest('[data-testid="chat-view-stub"]') === null);

describe('ConversationPage — the room head menu (story 4887 · UI-4 P3-a)', () => {
  it('⭐ the test helper leaves the menu popup OUT of its opening frame — so an item pressed next is a press the library takes (reverted: openMenu stops waiting → the popup still carries data-starting-style here, and the settings test failed in 6 whole-file runs of 6)', async () => {
    stubFetch(true, false); await mount();
    await openMenu();
    const popup = document.querySelector('[role=menu]') as HTMLElement;
    expect(popup, 'the popup is there').not.toBeNull();
    expect(popup.hasAttribute('data-starting-style')).toBe(false);
  });

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
    // the window mounts and takes focus; the menu closes — poll for both (their order depends on the load of the run). «Closed» is the menu's OPEN STATE (the trigger's aria-expanded), not whether the popup's element is already out of the DOM — that is the library's own exit timing
    await vi.waitFor(() => {
      expect(document.querySelector(`[aria-label="${koMessages.chats.deliveryContractFreeResponseLabel}"]`)).not.toBeNull();
      expect(triggerOf()!.getAttribute('aria-expanded')).toBe('false'); // reverted (menu never closes) → "true"
    });
  });
  // codex review of the first head (PR 5520): three real accessibility defects
  it('⭐ the muted state is spoken at every width — role=status, and the words are sr-only below sm (shown from sm), never display:none', async () => {
    stubFetch(true, true); await mount();
    const indicator = container.querySelector('[data-testid="room-muted-indicator"]') as HTMLElement;
    expect(indicator.getAttribute('role')).toBe('status');
    const words = [...indicator.querySelectorAll('span')].find((e) => e.textContent === koMessages.chats.notificationsMuted) as HTMLElement;
    expect(words.className).toContain('sr-only'); // reverted (`hidden sm:inline`) → a phone screen reader hears nothing
    expect(words.className).toContain('sm:not-sr-only');
    expect(words.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('⭐ the mute menu item carries no aria-pressed (it is not valid on a menuitem — the words themselves say 끄기 / 켜기)', async () => {
    stubFetch(true, true); await mount(); await openMenu();
    const mute = document.querySelector('[data-testid="room-head-mute"]') as HTMLElement;
    expect(mute.getAttribute('aria-pressed')).toBeNull(); // reverted → "true"
  });

  it('⭐ closing the notification-settings window returns focus to the «⋯» button — not the page body (the menu item that opened it is gone)', async () => {
    stubFetch(true, false, 'group'); await mount(); await openMenu();
    await act(async () => { (document.querySelector('[data-testid="room-head-settings"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === koMessages.common.close)).toBe(true));
    const close = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === koMessages.common.close) as HTMLElement;
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => {
      expect(document.querySelector(`[aria-label="${koMessages.chats.deliveryContractFreeResponseLabel}"]`)).toBeNull(); // the window is gone
      expect(document.activeElement).toBe(triggerOf()); // reverted (no finalFocus) → body
    });
  });

});
