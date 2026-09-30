// story 4427 — an organization-less user on the way to the desktop setup page keeps that destination through onboarding
// (`/onboarding?next=%2Fdesktop%2Fsetup`); every other path still goes to plain /onboarding. Calls the layout itself.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const req = { headers: new Headers(), cookies: new Map<string, string>() };
vi.mock('next/headers', () => ({
  headers: async () => req.headers,
  cookies: async () => ({ get: (name: string) => (req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined) }),
}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ access_token: 't' }) }));
vi.mock('../dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/storage/storage-capacity-toast-provider', () => ({ StorageCapacityToastProvider: () => null }));
vi.mock('@/components/chat/cross-project-toast-provider', () => ({ CrossProjectToastProvider: () => null }));
vi.mock('@/ee/components/billing/au-usage-banner', () => ({ AuUsageBanner: () => null }));

let meStatus = 404;
let meBody: unknown = null;
beforeEach(() => {
  req.cookies = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/me') return { ok: meStatus === 200, status: meStatus, json: async () => meBody };
    return { ok: true, status: 200, json: async () => [] };
  }));
});

async function redirectFor(pathname: string): Promise<string> {
  req.headers = new Headers({ 'x-pathname': pathname });
  const { default: AuthenticatedLayout } = await import('./layout');
  try {
    await AuthenticatedLayout({ children: null });
  } catch (e) {
    return String((e as Error).message);
  }
  return 'no redirect';
}

describe('(authenticated) layout — organization-less user', () => {
  it.each([
    [404, null],
    [200, { id: 'x', org_id: null }],
  ])('/me %s: /desktop/setup stays (the page decides the «새 조직» mode); any other path → plain /onboarding', async (status, body) => {
    meStatus = status as number;
    meBody = body;
    expect(await redirectFor('/desktop/setup')).toBe('no redirect');
    expect(await redirectFor('/desktop/setup?p=x#c')).toBe('no redirect');
    expect(await redirectFor('/chats')).toBe('redirect:/onboarding');
    expect(await redirectFor('/desktop/setupx')).toBe('redirect:/onboarding');
    expect(await redirectFor('/desktop/setup/other')).toBe('redirect:/onboarding');
  });

  it('a person with an organization is unchanged: /desktop/setup renders inside the shell, no redirect', async () => {
    meStatus = 200;
    meBody = { id: 'x', org_id: 'o', project_id: 'p' };
    expect(await redirectFor('/desktop/setup')).toBe('no redirect');
  });
});
