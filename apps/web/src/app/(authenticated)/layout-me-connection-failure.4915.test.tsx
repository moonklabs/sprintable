// story 4915 (PO 11-12 «dev 로그인이 왜이리 자주 풀리는지») — the authenticated layout's own comment says «only a 401 (the session expired) goes to /login; any other error keeps the page»,
// but its code is `if (!meRes || meRes.status === 401) redirect(login)`: when the `/api/v2/me` request is REJECTED (connection reset / refused / timeout — the `.catch(() => null)`), `meRes` is null and
// the person is sent to /login although the session is alive (the cookie is not cleared, the refresh token is not revoked — the server never ended it). Measured around a dev deploy: a request hung
// 173 s and ended in ECONNRESET; before that, 30 s+ answers. This file pins WHAT SHOULD HAPPEN: only a real 401 is the sign-in; a connection failure (or 5xx) is an error, never the sign-in.
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
// an exact sentinel (identity, not a name): the layout's tree must contain THIS component to count as «the retry screen»
const FailureScreen = vi.hoisted(() => function AccountContextFailureStandIn() { return null; });
vi.mock('./account-context-failure', () => ({ AccountContextFailure: FailureScreen }));

type MeMode = 'ok' | '401' | '502' | 'reject-reset' | 'reject-refused' | 'reject-timeout';
let meMode: MeMode = 'ok';
beforeEach(() => {
  req.cookies = new Map();
  meMode = 'ok';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/me') {
      if (meMode === 'reject-reset') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      if (meMode === 'reject-refused') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      if (meMode === 'reject-timeout') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
      if (meMode === '401') return { ok: false, status: 401, json: async () => ({}) };
      if (meMode === '502') return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: 'm1', org_id: 'o1', project_id: 'p1', project_name: 'P', name: 'N' }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  }));
});

/** does the element tree contain an element of this component (walks props.children — the layout returns a plain element tree) */
function containsFailureScreen(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === FailureScreen) return true;
  const kids = el.props?.children;
  return Array.isArray(kids) ? kids.some(containsFailureScreen) : containsFailureScreen(kids);
}

/** 'redirect:<url>' for a redirect · 'retry-screen' when the layout hands back the «다시 시도» screen · 'error:<message>' for a thrown error · 'page' for the normal page. */
async function outcomeFor(pathname: string): Promise<string> {
  req.headers = new Headers({ 'x-pathname': pathname });
  const { default: AuthenticatedLayout } = await import('./layout');
  try {
    const out = await AuthenticatedLayout({ children: null });
    return containsFailureScreen(out) ? 'retry-screen' : 'page';
  } catch (e) {
    const message = String((e as Error).message);
    return message.startsWith('redirect:') ? message : `error:${message}`;
  }
}

describe('(authenticated) layout — /login is the answer to a 401 only (story 4915: the dev login drops)', () => {
  it('control: the request answers 401 → the sign-in, the page kept as `next`', async () => {
    meMode = '401';
    expect(await outcomeFor('/chats')).toBe('redirect:/login?next=%2Fchats&reason=session_expired');
  });

  it('the request answers 5xx (502 behind a deploy) → the «다시 시도» screen the layout hands back, NOT the sign-in and NOT a throw (a layout\'s throw is not caught by its own segment\'s error.tsx → Next\'s bare 500 page)', async () => {
    meMode = '502';
    expect(await outcomeFor('/chats')).toBe('retry-screen');
  });

  it('control: a healthy answer renders the page', async () => {
    expect(await outcomeFor('/chats')).toBe('page');
  });

  it.each<[string, MeMode]>([
    ['the connection was reset mid-request (ECONNRESET — what the 173 s hang ended in)', 'reject-reset'],
    ['the connection was refused (the backend is not up yet — a deploy\'s 502 window seen from the web server)', 'reject-refused'],
    ['the connection timed out', 'reject-timeout'],
  ])('⭐ %s → NOT the sign-in: the session is alive, nothing here ended it — the «다시 시도» screen, like a 5xx', async (_name, mode) => {
    meMode = mode;
    const outcome = await outcomeFor('/chats');
    expect(outcome, 'a rejected /api/v2/me request must not read as «the session ended»').not.toMatch(/^redirect:\/login/);
    expect(outcome).toBe('retry-screen');
  });
});
