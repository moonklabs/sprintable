// @vitest-environment jsdom
//
// story 5031 (pencil follow-up) — a group room's «이름 바꾸기» is also the FIRST line of the head's «⋯» menu (the desktop pencil is quiet until hover / focus; a phone has the menu next to its title button). REAL page + REAL bar + REAL head + the REAL base-ui menu.
// The trap this pins: choosing the line closes the menu, and the menu would hand the focus back to «⋯» — which BLURS the rename input that just opened (its onBlur saves = closes it). So the input is opened after the menu has closed and that one close does not return the focus.
// The opener is the pencil's own (`startRename`), so a rename by the menu sends the very same request as one by the pencil. jsdom is an approximation of the library's focus return (no layout, no real focus trap) — the real browser is not exercised here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, routeId } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), routeId: { current: 'conv-1' } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  usePathname: () => `/chats/${routeId.current}`,
  useParams: () => ({ conversation_id: routeId.current }),
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
    if (/\/api\/conversations\/conv-\d$/.test(u) && init?.method === 'PATCH') { patches.push(JSON.parse(init.body ?? '{}')); return { ok: true, status: 200, json: async () => ({}) }; }
    if (/\/api\/conversations\/conv-\d$/.test(u)) {
      const kind = u.endsWith('conv-3') ? 'dm' : type; // conv-3 is always a one-to-one room (no rename)
      return { ok: true, status: 200, json: async () => ({ title: kind === 'group' ? (u.endsWith('conv-2') ? '둘째 방' : '점심 모임') : null, type: kind, muted: false, last_read_at: null, free_response: false, project_id: 'proj-1', is_project_channel: false, participants: [{ member_id: 'me-1', name: '나', avatar_url: null, type: 'human' }, { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }));
}
beforeEach(() => {
  routeId.current = 'conv-1';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1', projectMemberships: [] });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

let makeTree: () => React.ReactElement = () => <></>;
async function mountWithBar() {
  const { default: ConversationPage } = await import('./page');
  const { TopBar } = await import('@/components/nav/top-bar');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { ToastProvider } = await import('@/components/ui/toast');
  makeTree = () => (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider><TopBarProvider pathname={`/chats/${routeId.current}`}><SidebarProvider>
        <TopBar orgId="o1" orgMemberships={[{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }]} projectId="proj-1" projectMemberships={[{ projectId: 'proj-1', projectName: '스프린터블' }]} />
        <ConversationPage />
      </SidebarProvider></TopBarProvider></ToastProvider>
    </NextIntlClientProvider>
  );
  await act(async () => { root.render(makeTree()); });
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

/** a matchMedia that follows a window width the way a browser's does — so the REAL page takes its phone shape (below lg: the room's name · people · «⋯» in the bar; no desktop head, no pencil) */
function emulateWidth(width: number) {
  const matches = (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q)?.[1];
    const min = /min-width:\s*(\d+)px/.exec(q)?.[1];
    return (max === undefined || width <= Number(max)) && (min === undefined || width >= Number(min));
  };
  vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return matches(q); }, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal('innerWidth', width);
}
const titleButton = () => container.querySelector(`[data-testid="room-bar"] button[aria-label="${koMessages.chats.editRoomName}"]`) as HTMLButtonElement | null;

describe('[SID:5031 · pencil · codex] a PHONE: the focus after the rename goes back to the title button — never to the page body', () => {
  async function toPhone() { stubRoom('group'); emulateWidth(390); await mountWithBar(); }

  it('⭐phone shape: no pencil, the title button is the way in, and the menu has the line too', async () => {
    await toPhone();
    expect(pencil()).toBeNull();
    expect(titleButton(), 'the phone\'s title button').not.toBeNull();
    await openMenu();
    expect(menuRename(), 'the «⋯» menu line on a phone').not.toBeNull();
  });

  it('⭐menu line → input → Enter: ONE PATCH, and the focus lands on the title button (not the body)', async () => {
    await toPhone();
    await openMenu();
    await act(async () => { menuRename()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
    await settle();
    expect(document.activeElement, 'the focus is on the input while editing').toBe(input());
    await type(input()!, '저녁 모임');
    await act(async () => { key(input()!, 'Enter'); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    await settle();
    expect(patches).toEqual([{ title: '저녁 모임' }]);
    expect(input()).toBeNull();
    expect(titleButton()).not.toBeNull();
    expect(document.activeElement, 'reverted (the pencil is the only target) → <body>').toBe(titleButton());
  });

  it('⭐menu line → input → Esc: nothing sent, the focus lands on the title button', async () => {
    await toPhone();
    await openMenu();
    await act(async () => { menuRename()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
    await settle();
    await act(async () => { key(input()!, 'Escape'); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    await settle();
    expect(patches).toHaveLength(0);
    expect(document.activeElement).toBe(titleButton());
  });

  it('⭐the title button\'s own way (the hole that was there before): button → input → Enter / Esc → the focus is back on the title button', async () => {
    await toPhone();
    await act(async () => { titleButton()!.click(); });
    expect(input()).not.toBeNull();
    await act(async () => { key(input()!, 'Escape'); });
    await settle();
    expect(document.activeElement, 'after Esc').toBe(titleButton());
    await act(async () => { titleButton()!.click(); });
    await type(input()!, '또 다른 이름');
    await act(async () => { key(input()!, 'Enter'); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    await settle();
    expect(patches).toEqual([{ title: '또 다른 이름' }]);
    expect(document.activeElement, 'after Enter').toBe(titleButton());
  });
});

describe('[SID:5031 · pencil · codex] the opening that waits for the menu to close is cancelled when it goes stale', () => {
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  it('⭐the room changes before the timer fires → the input does not open on the OTHER room (it would have opened with the first room\'s draft)', async () => {
    stubRoom('group');
    await mountWithBar();
    await openMenu();
    // one synchronous step: choose the line (the menu closes · the timer is set) and move to another room before the timer can fire
    await act(async () => {
      click(menuRename()!);
      routeId.current = 'conv-2';
      root.render(makeTree());
    });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    await settle();
    expect(barH1()!.textContent, 'we are in the other room').toBe('둘째 방');
    expect(input(), 'reverted (no cancel · no re-check) → the rename input is open on the other room').toBeNull();
    expect(patches).toHaveLength(0);
  });

  it('⭐the menu is opened again before the timer fires → the pending opening is cancelled (the input does not open under the open menu)', async () => {
    stubRoom('group');
    await mountWithBar();
    await openMenu();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // hold the one-tick timer so «before it fires» is a state, not a race
    try {
      await act(async () => { click(menuRename()!); }); // the menu closes; the opening waits for its tick
      await act(async () => { trigger().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); click(trigger()); }); // …and the person opens the menu again
      await act(async () => { vi.advanceTimersByTime(50); }); // the tick comes
    } finally { vi.useRealTimers(); }
    await settle();
    expect(input(), 'reverted (no cancel on re-open) → the input opens').toBeNull();
    expect(trigger().getAttribute('aria-expanded'), 'the menu is the one that is open').toBe('true');
  });
});

describe('[SID:5031 · pencil · codex 2 · LOW] the pending opening under StrictMode', () => {
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // «the page goes away while the opening waits» is not pinned: counting timers cannot tell the opening's from the library's own (measured: a library timer is left after an unmount with or without ours) — the cleanup that clears it is the one the room-change test exercises.
  it('StrictMode (effects run twice): the line still opens the input once, focused, and it stays', async () => {
    stubRoom('group');
    await mountWithBar();
    await act(async () => { root.render(<StrictMode>{makeTree()}</StrictMode>); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    await openMenu();
    await act(async () => { click(menuRename()!); });
    await vi.waitFor(() => expect(input()).not.toBeNull());
    await settle();
    expect(container.querySelectorAll('input[data-slot="input"]')).toHaveLength(1);
    expect(document.activeElement).toBe(input());
    expect(patches).toHaveLength(0);
  });
  // «another line chosen» is not pinned: the opening waits ONE tick (0 ms) after the menu closed — no other line can be chosen in that time; the cancel in each other line's onClick is code only.
});

describe('[SID:5031 · pencil · codex 2] leaving a room closes the name edit of THAT room (the page component is reused between rooms)', () => {
  const goTo = async (id: string) => { await act(async () => { routeId.current = id; root.render(makeTree()); }); await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); await settle(); };

  it('⭐HIGH 1: an edit left open in room A (no blur — e.g. the browser\'s back) is closed in room B, and B\'s own name — never A\'s half-written draft — is what the next edit starts from; nothing is sent', async () => {
    stubRoom('group');
    await mountWithBar();
    await act(async () => { pencil()!.click(); });
    await type(input()!, 'A에서 쓰다 만 이름');
    expect(input()!.value).toBe('A에서 쓰다 만 이름');
    await goTo('conv-2');
    expect(barH1()!.textContent).toBe('둘째 방');
    expect(input(), 'reverted → B draws A\'s input with A\'s draft (an Enter would rename B)').toBeNull();
    expect(patches, 'leaving discards the draft — it is not saved (the target of a save from here would be the wrong room)').toHaveLength(0);
    await act(async () => { pencil()!.click(); });
    expect(input()!.value, 'the next edit starts from B\'s own name').toBe('둘째 방');
    await act(async () => { key(input()!, 'Enter'); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(patches, 'unchanged name → no request').toHaveLength(0);
  });

  it('⭐HIGH 2 (a phone): Enter in room A, then a room with no title button (a DM) — no focus request is left behind: the next room that has a title button does not have its focus stolen', async () => {
    stubRoom('group');
    emulateWidth(390);
    await mountWithBar();
    await act(async () => { titleButton()!.click(); });
    await type(input()!, '이름');
    // Enter and the move to the DM happen before the bar has drawn A's title button again
    await act(async () => { key(input()!, 'Enter'); routeId.current = 'conv-3'; root.render(makeTree()); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(titleButton(), 'a DM has no rename button').toBeNull();
    // straight on to a group room (before the 50 ms the phone's fallback waits for the title button — that timer would hand the focus to «⋯» of the DM by itself): its title button mounts
    await goTo('conv-2');
    expect(titleButton()).not.toBeNull();
    expect(document.activeElement, 'reverted → the left-over request steals the focus into this room\'s title button').not.toBe(titleButton());
  });
});
