// @vitest-environment jsdom
//
// story 5031 (C1 step 5b) — the room's name moved from the head to the top bar (the page's one h1). A GROUP room's name can be changed: that must survive the move. The way is a pencil button in the head (a named button; the bar's crumb is a heading — no control inside it, and the bar is the
// window's drag strip with the path's switcher and the search field in it). REAL page + REAL bar + REAL head: press the pencil → the input (same one the phone uses) → type → Enter saves (PATCH) and the bar's h1 shows the new name · Esc cancels (no PATCH) and the focus returns to the pencil.
// A one-to-one room has no pencil (its name is the other person's). The IME keys of the input are page.ime.4831.test.tsx (unchanged, green).
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

describe('[SID:5031 · 5b] renaming a group room survives the name moving to the bar', () => {
  it('⭐the head has a NAMED rename button (a pencil) — and no heading; the name is the bar\'s h1', async () => {
    stubRoom('group');
    await mountWithBar();
    expect(pencil(), 'the rename button is in the head').not.toBeNull();
    expect(pencil()!.tagName).toBe('BUTTON');
    expect(barH1()!.textContent).toBe('점심 모임');
    expect(container.querySelector('[data-testid="room-head"]')!.querySelectorAll('h1, [role="heading"]')).toHaveLength(0);
  });

  it('⭐press the pencil → the input with the current name → type + Enter: the server gets {title}, the bar\'s h1 shows the new name at once, and the focus returns to the pencil', async () => {
    stubRoom('group');
    await mountWithBar();
    await act(async () => { pencil()!.click(); });
    expect(input()!.value).toBe('점심 모임');
    expect(pencil(), 'the pencil gives way to the input').toBeNull();
    await type(input()!, '  저녁 모임  ');
    await act(async () => { key(input()!, 'Enter'); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(patches).toEqual([{ title: '저녁 모임' }]); // trimmed, once
    expect(input()).toBeNull();
    expect(barH1()!.textContent, 'the path\'s last crumb follows the new name').toBe('저녁 모임');
    expect(document.activeElement, 'the focus is back on the pencil').toBe(pencil());
  });

  it('Esc cancels: nothing is sent, the name is unchanged, the focus returns to the pencil', async () => {
    stubRoom('group');
    await mountWithBar();
    await act(async () => { pencil()!.click(); });
    await type(input()!, '버릴 이름');
    await act(async () => { key(input()!, 'Escape'); });
    expect(patches).toHaveLength(0);
    expect(barH1()!.textContent).toBe('점심 모임');
    expect(document.activeElement).toBe(pencil());
  });

  it('a one-to-one room has no pencil (its name is the other person\'s) and its h1 is the bar\'s', async () => {
    stubRoom('dm');
    await mountWithBar();
    expect(pencil()).toBeNull();
    expect(barH1()!.textContent).toBe('유나');
  });
});
