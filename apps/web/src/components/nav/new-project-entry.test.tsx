// @vitest-environment jsdom
//
// story 4713 (UX-1) — inside the desktop app «새 프로젝트» is one always-visible line right under the project switcher; it hands the
// shell the app's own setup link (the one app link the shell takes in place). A browser has no bridge: nothing is drawn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/dashboard' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { NewProjectEntry, MoveAgentsEntry, NEW_PROJECT_LINK, MOVE_AGENTS_LINK, OPEN_NEW_PROJECT_EVENT, NEW_PROJECT_PARAM } = await import('./new-project-entry');
const { AppSidebar } = await import('./app-sidebar');
const { SidebarProvider } = await import('@/components/ui/sidebar');
const { EmbeddedServerProvider } = await import('@/components/embedded-server-context');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridge = Object.freeze({
  inApp: true as const, device: { name: 'yoonjae의 맥' }, runtimes: [] as { runtime: 'claude' | 'codex'; version: string; executable: string }[],
  pickFolder: vi.fn(async () => null), startHere: vi.fn(async () => ({ ok: true as const })), setProjectFolder: vi.fn(async () => ({ ok: true as const })),
});
const inApp = () => { (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = bridge; };

let container: HTMLDivElement;
let root: Root;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { inboxUnreadCount: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop;
  vi.unstubAllGlobals();
});

const withProviders = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SidebarProvider>{node}</SidebarProvider></NextIntlClientProvider>
);
const entry = () => container.querySelector('[data-testid=sidebar-new-project]') as HTMLButtonElement | null;
const moveEntry = () => container.querySelector('[data-testid=sidebar-move-agents]') as HTMLButtonElement | null;

describe('[SID:4713 · 4832] NewProjectEntry — does what its name says', () => {
  it('in the app: one line «새 프로젝트» that asks the shell to open the project dialog — it hands the shell NO setup link', async () => {
    inApp();
    const opened = vi.fn();
    window.addEventListener(OPEN_NEW_PROJECT_EVENT, opened);
    await act(async () => { root.render(withProviders(<NewProjectEntry />)); });
    expect(entry()).not.toBeNull(); // reverted (nothing drawn) → fails
    expect(entry()!.textContent).toBe('새 프로젝트');
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(opened).toHaveBeenCalledTimes(1); // the old behaviour (the app's setup link) → 0 events → fails
    expect(assign).not.toHaveBeenCalled();
    window.removeEventListener(OPEN_NEW_PROJECT_EVENT, opened);
    expect(NEW_PROJECT_LINK).toBe('ai.sprintable:/desktop/setup'); // the browser dialog's Mac block still uses it
  });

  it('in a browser (no bridge): nothing is drawn', async () => {
    await act(async () => { root.render(withProviders(<NewProjectEntry />)); });
    expect(entry()).toBeNull();
    await act(async () => { root.render(withProviders(<MoveAgentsEntry />)); });
    expect(moveEntry()).toBeNull();
  });
});

describe('[SID:4832] MoveAgentsEntry — «이 컴퓨터로 에이전트 옮기기»', () => {
  it('in the app: a line named by what it does that hands the shell the app\'s setup link with intent=move — exactly the constant', async () => {
    inApp();
    await act(async () => { root.render(withProviders(<MoveAgentsEntry />)); });
    expect(moveEntry()).not.toBeNull();
    expect(moveEntry()!.textContent).toBe('이 컴퓨터로 에이전트 옮기기');
    await act(async () => { moveEntry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('ai.sprintable:/desktop/setup?intent=move'); // the one app link the shell takes in place
    expect(MOVE_AGENTS_LINK).toBe('ai.sprintable:/desktop/setup?intent=move');
  });

  it('the address is the constant — no page address, query or storage leaks into it', async () => {
    inApp();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, href: 'https://evil.example/?next=x', search: '?agent=other', assign } });
    window.localStorage.setItem('pending-setup', 'agent=other');
    await act(async () => { root.render(withProviders(<MoveAgentsEntry />)); });
    await act(async () => { moveEntry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(String(assign.mock.calls[0]![0])).toBe('ai.sprintable:/desktop/setup?intent=move');
  });
});

describe('[SID:4713] the real sidebar draws it under the switcher — inside the app only', () => {
  async function mountSidebar() {
    await act(async () => { root.render(withProviders(<AppSidebar projectMemberships={[]} chatUnreadTotal={0} />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('in the app: the line is in the sidebar header, after the switcher trigger and before the search', async () => {
    inApp();
    await mountSidebar();
    const line = entry();
    expect(line).not.toBeNull(); // built but not wired → fails
    const header = line!.parentElement!;
    const kids = Array.from(header.children);
    const search = kids.find((k) => k.textContent?.includes('⌘K'))!;
    expect(kids.indexOf(line!)).toBeLessThan(kids.indexOf(search));
    expect(kids.indexOf(line!)).toBeGreaterThan(0); // the switcher comes first
  });

  it('4832: the move line is the next line, right under «새 프로젝트» (two doors, each named by what it does)', async () => {
    inApp();
    await mountSidebar();
    const kids = Array.from(entry()!.parentElement!.children);
    expect(kids.indexOf(moveEntry()!)).toBe(kids.indexOf(entry()!) + 1); // not wired → fails
  });

  it('4832: pressing the sidebar\'s «새 프로젝트» opens the project dialog (the one the switcher\'s menu opens) — and only one', async () => {
    inApp();
    await mountSidebar();
    expect(document.body.textContent).not.toContain(koMessages.nav.switcherNewProjectDialogTitle);
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.nav.switcherNewProjectDialogTitle); // listener removed → no dialog → fails
    expect(document.querySelectorAll('[role=dialog]').length).toBe(1);
    expect(assign).not.toHaveBeenCalled(); // no app link: the person is creating a project, not starting a setup
  });

  const at = (href: string) => Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, href, assign } });

  it('4832: the app menu\'s ⌘N — the flag on the address opens the dialog once and is taken off (a reload does not open it again)', async () => {
    inApp();
    at(`http://localhost/dashboard/chats?x=1&${NEW_PROJECT_PARAM}=1#top`);
    const replace = vi.spyOn(window.history, 'replaceState');
    await mountSidebar();
    expect(document.body.textContent).toContain(koMessages.nav.switcherNewProjectDialogTitle); // flag not read → no dialog → fails
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]![2]).toBe('/dashboard/chats?x=1#top'); // taken off, the rest of the address kept
    expect(document.querySelectorAll('[role=dialog]').length).toBe(1);
    replace.mockRestore();
  });

  it('4832: in a browser (no bridge) the flag and the window event open nothing and the address is left alone', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    at(`http://localhost/dashboard/chats?${NEW_PROJECT_PARAM}=1`);
    await mountSidebar();
    await act(async () => { window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT)); });
    expect(document.body.textContent).not.toContain(koMessages.nav.switcherNewProjectDialogTitle); // no bridge check → the dialog opens → fails
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it('4832: other values of the flag (and none) open nothing and rewrite nothing', async () => {
    inApp();
    const replace = vi.spyOn(window.history, 'replaceState');
    for (const href of [`http://localhost/dashboard?${NEW_PROJECT_PARAM}=0`, 'http://localhost/dashboard']) {
      at(href);
      await mountSidebar();
      expect(document.body.textContent).not.toContain(koMessages.nav.switcherNewProjectDialogTitle);
      await act(async () => { root.render(<div />); });
    }
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it('in a browser the sidebar is as before — no extra line', async () => {
    await mountSidebar();
    expect(entry()).toBeNull();
    expect(moveEntry()).toBeNull();
  });
});

describe('[SID:4832] MoveAgentsEntry on the app\'s own server', () => {
  it('inside the app but on its own (local) server there is no other computer\'s server to move agents from: no line; on a hosted server the line is there as before', async () => {
    inApp();
    await act(async () => { root.render(withProviders(<EmbeddedServerProvider embedded><MoveAgentsEntry /></EmbeddedServerProvider>)); });
    expect(moveEntry()).toBeNull();
    await act(async () => { root.render(withProviders(<EmbeddedServerProvider embedded={false}><MoveAgentsEntry /></EmbeddedServerProvider>)); });
    expect(moveEntry()).not.toBeNull();
    expect(moveEntry()?.textContent).toBe('이 컴퓨터로 에이전트 옮기기');
  });
});
