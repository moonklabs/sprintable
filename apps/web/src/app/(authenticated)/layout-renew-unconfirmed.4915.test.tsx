// story 4915 (PR 2) — the renew road (`/api/auth/renew`) could not CONFIRM anything (its refresh call was rejected · 5xx) and left the 10-second `sp_renew_unconfirmed` cookie, nothing cleared. The authenticated layout
// answers `membership_elsewhere` with the «다시 시도» screen while that cookie lives — NOT another round through the road (a loop) and NOT the sign-in. The first visit still goes through the road; a finished
// renewal (`sp_renew_tried`) keeps the old reading (the sign-in).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const req = { headers: new Headers(), cookies: new Map<string, string>() };
vi.mock('next/headers', () => ({
  headers: async () => req.headers,
  cookies: async () => ({ get: (name: string) => (req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined) }),
}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ access_token: 't', user_id: 'u1' }) }));
vi.mock('../dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/storage/storage-capacity-toast-provider', () => ({ StorageCapacityToastProvider: () => null }));
vi.mock('@/components/chat/cross-project-toast-provider', () => ({ CrossProjectToastProvider: () => null }));
vi.mock('@/ee/components/billing/au-usage-banner', () => ({ AuUsageBanner: () => null }));
vi.mock('@/components/auth/tab-owner-gate', () => ({ TabOwnerGate: ({ children }: { children: React.ReactNode }) => children }));
// an exact sentinel (identity, not a name)
const FailureScreen = vi.hoisted(() => function AccountContextFailureStandIn() { return null; });
vi.mock('@/components/auth/account-context-failure', () => ({ AccountContextFailure: FailureScreen }));

function containsFailureScreen(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === FailureScreen) return true;
  const kids = el.props?.children;
  return Array.isArray(kids) ? kids.some(containsFailureScreen) : containsFailureScreen(kids);
}

async function outcomeFor(pathname: string): Promise<string> {
  req.headers = new Headers({ 'x-pathname': pathname });
  const { default: AuthenticatedLayout } = await import('./layout');
  try {
    const out = await AuthenticatedLayout({ children: null });
    return containsFailureScreen(out) ? 'retry-screen' : 'page';
  } catch (e) {
    const m = String((e as Error).message);
    return m.startsWith('redirect:') ? m : `error:${m}`;
  }
}

beforeEach(() => {
  req.cookies = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    if (p === '/api/v2/me') return { ok: false, status: 404, json: async () => ({ data: null, error: { code: 'NOT_FOUND', message: 'Member not found', reason: 'membership_elsewhere' }, meta: null }) };
    return { ok: true, status: 200, json: async () => [] };
  }));
});

describe('(authenticated) layout — membership_elsewhere and the renew road\'s «could not confirm» cookie (story 4915)', () => {
  it('the first visit still goes through the renew road (unchanged)', async () => {
    expect(await outcomeFor('/chats')).toBe('redirect:/api/auth/renew?next=%2Fchats');
  });

  it('with the 10-second «could not confirm» cookie: the «다시 시도» screen — no second round through the road (no loop), not the sign-in', async () => {
    req.cookies = new Map([['sp_renew_unconfirmed', '1']]);
    expect(await outcomeFor('/chats')).toBe('retry-screen');
  });

  it('with the «renewal already tried» marker the old reading stays: the sign-in (the unconfirmed cookie does not override a finished renewal)', async () => {
    req.cookies = new Map([['sp_renew_tried', '1'], ['sp_renew_unconfirmed', '1']]);
    expect(await outcomeFor('/chats')).toBe('redirect:/login?next=%2Fchats&reason=session_expired');
  });
});
