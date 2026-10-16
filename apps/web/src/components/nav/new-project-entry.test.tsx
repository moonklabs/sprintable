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

const { NewProjectEntry, NEW_PROJECT_LINK } = await import('./new-project-entry');
const { AppSidebar } = await import('./app-sidebar');
const { SidebarProvider } = await import('@/components/ui/sidebar');

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

describe('[SID:4713] NewProjectEntry', () => {
  it('in the app: one line «새 프로젝트» that hands the shell the app\'s own setup link', async () => {
    inApp();
    await act(async () => { root.render(withProviders(<NewProjectEntry />)); });
    expect(entry()).not.toBeNull(); // reverted (nothing drawn) → fails
    expect(entry()!.textContent).toBe('새 프로젝트');
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('ai.sprintable:/desktop/setup'); // the one link the shell takes in place (navigation.ts APP_SETUP_LINK)
    expect(NEW_PROJECT_LINK).toBe('ai.sprintable:/desktop/setup');
  });

  it('the address is the constant — not the page address, the query, storage or the clipboard (codex QA)', async () => {
    inApp();
    // an address that carries other values must never leak into what the shell is handed
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, href: 'https://evil.example/?next=ai.sprintable:/desktop/setup%3Fagent%3Dx', search: '?agent=other&code=abc', assign } });
    window.localStorage.setItem('pending-setup', 'agent=other');
    await act(async () => { root.render(withProviders(<NewProjectEntry />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]![0]).toBe('ai.sprintable:/desktop/setup'); // exactly the constant, no query, no fragment
    expect(String(assign.mock.calls[0]![0])).not.toMatch(/[?#]|agent|code|evil/);
  });

  it('in a browser (no bridge): nothing is drawn', async () => {
    await act(async () => { root.render(withProviders(<NewProjectEntry />)); });
    expect(entry()).toBeNull();
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

  it('in a browser the sidebar is as before — no extra line', async () => {
    await mountSidebar();
    expect(entry()).toBeNull();
  });
});
