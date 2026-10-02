// @vitest-environment jsdom
//
// story #4490 (Kadir 4903 · PO 05:50Z) — every branch of the (authenticated) layout goes through TabOwnerGate, the
// organization-less desktop setup page included: that is exactly the «log out → another person signs up → /desktop/setup» way,
// and that page reads the desktop setup id and the tab project. The layout is called directly (as layout-critical-path does)
// and what it returns is rendered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabOwnerGate } from '@/components/auth/tab-owner-gate';

const req = { headers: new Headers(), cookies: new Map<string, string>() };
vi.mock('next/headers', () => ({
  headers: async () => req.headers,
  cookies: async () => ({ get: (name: string) => (req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined) }),
}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ access_token: 't', org_id: null, user_id: 'user-b' }) }));
vi.mock('../dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/storage/storage-capacity-toast-provider', () => ({ StorageCapacityToastProvider: () => null }));
vi.mock('@/components/chat/cross-project-toast-provider', () => ({ CrossProjectToastProvider: () => null }));
vi.mock('@/ee/components/billing/au-usage-banner', () => ({ AuUsageBanner: () => null }));

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let meAnswer: { status: number; body: unknown };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  req.headers = new Headers({ 'x-pathname': '/desktop/setup' });
  req.cookies = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/me') return { ok: meAnswer.status < 400, status: meAnswer.status, json: async () => meAnswer.body };
    return { ok: true, status: 200, json: async () => [] };
  }));
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function layout(): Promise<ReactElement<{ userId?: string; children?: unknown }>> {
  const { default: AuthenticatedLayout } = await import('./layout');
  return (await AuthenticatedLayout({ children: <p data-testid="setup-page">setup</p> })) as ReactElement<{ userId?: string; children?: unknown }>;
}

describe('[SID:4490] the (authenticated) layout always checks the browser owner first', () => {
  it.each([
    ['no organization yet (/me 404)', { status: 404, body: null }],
    ['a /me without an organization', { status: 200, body: { id: 'tm-1', org_id: null } }],
  ] as const)('%s on the desktop setup page → TabOwnerGate around it · the previous person\'s values go', async (_n, answer) => {
    meAnswer = answer;
    window.localStorage.setItem('sprintable_tab_owner', 'user-a');
    window.sessionStorage.setItem('sprintable_tab_owner', 'user-a');
    window.sessionStorage.setItem('sprintable_desktop_setup_active', JSON.stringify({ setupId: 'setup-of-A', at: Date.now() }));
    window.sessionStorage.setItem('sprintable_tab_project_id', 'proj-of-A');

    const el = await layout();
    expect(el.type).toBe(TabOwnerGate);
    expect(el.props.userId).toBe('user-b');
    await act(async () => { root.render(el); });
    expect(container.querySelector('[data-testid="setup-page"]')).not.toBeNull();
    expect(window.sessionStorage.getItem('sprintable_desktop_setup_active')).toBeNull();
    expect(window.sessionStorage.getItem('sprintable_tab_project_id')).toBeNull();
    expect(window.sessionStorage.getItem('sprintable_tab_owner')).toBe('user-b');
  });

  it('the signed-in screen with an organization → the gate is around the shell too', async () => {
    req.headers = new Headers({ 'x-pathname': '/moonklabs/sprintable/flow', 'x-resolved-org-id': 'org-1', 'x-resolved-project-id': 'proj-1' });
    meAnswer = { status: 200, body: { id: 'tm-1', org_id: 'org-1', project_id: 'proj-1', name: 'U' } };
    const el = await layout();
    expect(el.type).toBe(TabOwnerGate);
    expect(el.props.userId).toBe('user-b');
  });
});
