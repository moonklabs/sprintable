// story 4762 — the authenticated layout read EVERY 404 of /api/v2/me as «no organization» and sent the person to the onboarding. A person who belongs to an organization
// the session's token does not name (me.py `reason: membership_elsewhere` — measured on an Android phone right after sign-up: the sign-up token has no organization
// claim) is not organization-less: the onboarding (or the desktop setup's «새 조직» mode) would let them create a second organization. They go to the sign-in (the
// session is out of step with the membership; a new sign-in issues the right claim). Only `no_membership` (and any 404 without a readable reason — an older backend)
// keeps the old reading. Calls the layout itself.
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

let meBody: unknown = null;
let meJsonThrows = false;
beforeEach(() => {
  req.cookies = new Map();
  meJsonThrows = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/me') return { ok: false, status: 404, json: async () => { if (meJsonThrows) throw new SyntaxError('Unexpected token <'); return meBody; } };
    return { ok: true, status: 200, json: async () => [] };
  }));
});

async function outcomeFor(pathname: string): Promise<string> {
  req.headers = new Headers({ 'x-pathname': pathname });
  const { default: AuthenticatedLayout } = await import('./layout');
  try {
    await AuthenticatedLayout({ children: null });
  } catch (e) {
    return String((e as Error).message);
  }
  return 'no redirect';
}

const envelope = (reason: string) => ({ data: null, error: { code: 'NOT_FOUND', message: 'Member not found', reason }, meta: null });
const detail = (reason: string) => ({ detail: { code: 'NOT_FOUND', message: 'Member not found', reason } });

describe('(authenticated) layout — a 404 of /api/v2/me is read by its reason (story 4762)', () => {
  it.each([
    ['the envelope shape', envelope('membership_elsewhere')],
    ['FastAPI\'s detail shape', detail('membership_elsewhere')],
  ])('membership_elsewhere (%s) → the sign-in with the page kept as `next`, never the onboarding', async (_n, body) => {
    meBody = body;
    expect(await outcomeFor('/chats')).toBe('redirect:/login?next=%2Fchats&reason=session_expired');
    expect(await outcomeFor('/glance?story=abc')).toBe('redirect:/login?next=%2Fglance%3Fstory%3Dabc&reason=session_expired');
  });

  it('…also on the desktop setup page, which otherwise stays for an organization-less person (its «새 조직» mode would create a second organization)', async () => {
    meBody = envelope('membership_elsewhere');
    expect(await outcomeFor('/desktop/setup')).toBe('redirect:/login?next=%2Fdesktop%2Fsetup&reason=session_expired');
  });

  it('no_membership (a person with no organization at all) is unchanged: the onboarding, and the desktop setup page stays', async () => {
    meBody = envelope('no_membership');
    expect(await outcomeFor('/chats')).toBe('redirect:/onboarding');
    expect(await outcomeFor('/desktop/setup')).toBe('no redirect');
    meBody = detail('no_membership');
    expect(await outcomeFor('/chats')).toBe('redirect:/onboarding');
  });

  it.each([
    ['a 404 with no reason (an older backend)', { data: null, error: { code: 'NOT_FOUND', message: 'Member not found' }, meta: null }],
    ['a 404 with another reason', envelope('something_else')],
    ['a 404 whose reason is not a word', { error: { reason: { x: 1 } } }],
    ['a 404 with an empty body', null],
  ])('%s keeps the old reading: the onboarding', async (_n, body) => {
    meBody = body;
    expect(await outcomeFor('/chats')).toBe('redirect:/onboarding');
    expect(await outcomeFor('/desktop/setup')).toBe('no redirect');
  });

  it('a 404 whose body is not JSON keeps the old reading too (nothing to read must not turn into the sign-in)', async () => {
    meJsonThrows = true;
    expect(await outcomeFor('/chats')).toBe('redirect:/onboarding');
  });
});
