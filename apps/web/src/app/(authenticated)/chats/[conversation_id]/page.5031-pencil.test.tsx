// @vitest-environment jsdom
//
// story 5031 (pencil follow-up) — a group room's «이름 바꾸기» is also the FIRST line of the head's «⋯» menu (the desktop pencil is quiet until hover / focus; a phone has the menu next to its title button). REAL page + REAL bar + REAL head + the REAL base-ui menu.
// The trap this pins: choosing the line closes the menu, and the menu would hand the focus back to «⋯» — which BLURS the rename input that just opened (its onBlur saves = closes it). So the input is opened after the menu has closed and that one close does not return the focus.
// The opener is the pencil's own (`startRename`), so a rename by the menu sends the very same request as one by the pencil. jsdom is an approximation of the library's focus return (no layout, no real focus trap) — the real browser is not exercised here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/chats/conv-1',
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/components/chat/chat-view', () => ({ ChatView: () => <div data-testid="chat-view-stub" /> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const patches: Array<{ title?: string }> = [];
function stubRoom(type: 'group' | 'dm') {
  patches.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/conversations/conv-1') && init?.method === 'PATCH') { patches.push(JSON.parse(init.body ?? '{}')); return { ok: true, status: 200, json: async () => ({}) }; }
    if (u.endsWith('/api/conversations/conv-1')) {
      return { ok: true, status: 200, json: async () => ({ title: type === 'group' ? '점심 모임' : null, type, muted: false, last_read_at: null, free_response: false, project_id: 'proj-1', is_project_channel: false, participants: [{ member_id: 'me-1', name: '나', avatar_url: null, type: 'human' }, { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }));
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1', projectMemberships: [] });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mountWithBar() {
  const { default: ConversationPage } = await import('./page');
  const { TopBar } = await import('@/components/nav/top-bar');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { ToastProvider } = await import('@/components/ui/toast');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider><TopBarProvider pathname="/chats/conv-1"><SidebarProvider>
          <TopBar orgId="o1" orgMemberships={[{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }]} projectId="proj-1" projectMemberships={[{ projectId: 'proj-1', projectName: '스프린터블' }]} />
          <ConversationPage />
        </SidebarProvider></TopBarProvider></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}
const pencil = () => container.querySelector(`[data-testid="room-head"] button[aria-label="${koMessages.chats.editRoomName}"]`) as HTMLButtonElement | null;
const input = () => container.querySelector(`input[data-slot="input"][aria-label="${koMessages.chats.editRoomName}"]`) as HTMLInputElement | null;
const barH1 = () => container.querySelector('[data-testid="top-bar-title"] h1') as HTMLElement | null;
async function type(el: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));


const trigger = () => container.querySelector('[data-testid="room-head-menu"]') as HTMLElement;
async function openMenu() {
  await act(async () => { trigger().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await vi.waitFor(() => {
    const popup = document.querySelector('[role=menu]');
    expect(popup, 'the menu popup is there').not.toBeNull();
    expect(popup!.hasAttribute('data-starting-style'), 'the popup has left its opening frame').toBe(false);
  });
}
const menuRename = () => document.querySelector('[data-testid="room-head-menu-rename"]') as HTMLElement | null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

describe('[SID:5031 · pencil] «이름 바꾸기» in the head\'s «⋯» menu', () => {
  it('⭐a group room: the line is the FIRST item of the menu (before mute · records · settings), with the pencil\'s words and the edit icon', async () => {
    stubRoom('group');
    await mountWithBar();
    await openMenu();
    const items = [...document.querySelectorAll('[role=menu] [role=menuitem]')];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toBe(menuRename()); // reverted (line last / absent) → another item or null
    expect(menuRename()!.textContent).toContain(koMessages.chats.editRoomName);
    expect(menuRename()!.querySelector('[data-icon="edit"]')).not.toBeNull();
  });

  it('a one-to-one room has no such line (its name is the other person\'s)', async () => {
    stubRoom('dm');
    await mountWithBar();
    await openMenu();
    expect(menuRename()).toBeNull();
    expect(document.querySelector('[data-testid="room-head-mute"]')).not.toBeNull(); // the menu itself is there
  });

  it('⭐THE TRAP: choosing the line → the menu closes AND the name input is open with the focus ON it — and stays so (the menu\'s focus return does not blur it into a save)', async () => {
    stubRoom('group');
    await mountWithBar();
    await openMenu();
    await act(async () => { menuRename()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(input(), 'the input opens').not.toBeNull());
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false')); // the menu is closed
    await settle(); // time for the library's own focus return to have happened if it were going to
    expect(input(), 'the input is still open (not saved/closed by a blur)').not.toBeNull();
    expect(document.activeElement, 'the focus is on the input — not on «⋯», not on the body').toBe(input());
    expect(input()!.value).toBe('점심 모임');
    expect(patches, 'nothing was saved by opening').toHaveLength(0);
  });

  it('⭐type + Enter after the menu line: ONE PATCH {title} (trimmed) — the same request the pencil sends — the bar follows, the focus goes to the pencil', async () => {
    stubRoom('group');
    await mountWithBar();
    await openMenu();
    await act(async () => { menuRename()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
    await settle();
    await type(input()!, '  저녁 모임  ');
    await act(async () => { key(input()!, 'Enter'); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    const viaMenu = [...patches];
    expect(viaMenu).toEqual([{ title: '저녁 모임' }]);
    expect(barH1()!.textContent).toBe('저녁 모임');
    expect(input()).toBeNull();
    expect(document.activeElement, 'back on the pencil (it is quiet, not hidden — it takes the focus and shows)').toBe(pencil());
    // …and the pencil's own path sends the same shape
    patches.length = 0;
    await act(async () => { pencil()!.click(); });
    await type(input()!, '다른 이름');
    await act(async () => { key(input()!, 'Enter'); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(patches).toEqual([{ title: '다른 이름' }]);
  });

  it('Esc in the input (opened by the menu line): nothing is sent, the name is unchanged, the focus goes to the pencil', async () => {
    stubRoom('group');
    await mountWithBar();
    await openMenu();
    await act(async () => { menuRename()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
    await settle();
    await type(input()!, '버릴 이름');
    await act(async () => { key(input()!, 'Escape'); });
    expect(patches).toHaveLength(0);
    expect(barH1()!.textContent).toBe('점심 모임');
    expect(document.activeElement).toBe(pencil());
  });

  it('⭐closing the menu any OTHER way still returns the focus to «⋯» and opens no input — also AFTER a rename by the menu (no state left over)', async () => {
    stubRoom('group');
    await mountWithBar();
    // a plain Esc on the menu
    await openMenu();
    await act(async () => { document.querySelector('[role=menu]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'));
    await settle();
    expect(input()).toBeNull();
    expect(document.activeElement, 'the focus came back to «⋯»').toBe(trigger());
    // rename by the menu, finish with Esc …
    await openMenu();
    await act(async () => { menuRename()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
    await settle();
    await act(async () => { key(input()!, 'Escape'); });
    // … then an Esc on the menu again: the focus returns to «⋯» (the earlier choice left nothing behind)
    await openMenu();
    await act(async () => { document.querySelector('[role=menu]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'));
    await settle();
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
