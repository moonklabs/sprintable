// story #4762 (AC2) — a new organization has no project of its own: `/me` says project_id = the organization id (sentinel, project_name null).
// The first project is made later (the computer's «start»), the person never picks it on the phone, and the chat list waited for one for ever
// (4758: «Loading…» 7 minutes). Calls the layout itself and reads the project id it hands the shell.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const req = { headers: new Headers(), cookies: new Map<string, string>() };
vi.mock('next/headers', () => ({
  headers: async () => req.headers,
  cookies: async () => ({ get: (name: string) => (req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined) }),
}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ access_token: 't', user_id: 'u1' }) }));
vi.mock('@/components/auth/tab-owner-gate', () => ({ TabOwnerGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/storage/storage-capacity-toast-provider', () => ({ StorageCapacityToastProvider: () => null }));
vi.mock('@/components/chat/cross-project-toast-provider', () => ({ CrossProjectToastProvider: () => null }));

let meBody: Record<string, unknown>;
let memberships: unknown[];
beforeEach(() => {
  req.headers = new Headers({ 'x-pathname': '/chats' });
  req.cookies = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/me') return { ok: true, status: 200, json: async () => meBody };
    if (path === '/api/v2/me/memberships') return { ok: true, status: 200, json: async () => memberships };
    return { ok: true, status: 200, json: async () => [] };
  }));
});

/** the `projectId` prop the layout puts on the shell (the shell is stubbed out; the element tree carries the props) */
async function shellProjectId(): Promise<string | undefined> {
  const { default: AuthenticatedLayout } = await import('./layout');
  const gate = (await AuthenticatedLayout({ children: null })) as ReactElement<{ children: ReactElement<{ projectId?: string }> }>;
  return gate.props.children.props.projectId;
}

describe('(authenticated) layout — the project the shell starts from (story #4762 AC2)', () => {
  it('a new organization (claim = organization id, no name) with exactly one project starts on that project', async () => {
    meBody = { id: 'm1', org_id: 'org-1', project_id: 'org-1', project_name: null };
    memberships = [{ projectId: 'p-only', projectName: 'ac5-proj' }];
    expect(await shellProjectId()).toBe('p-only');
  });

  it('with two projects and the same sentinel claim nothing is picked for the person', async () => {
    meBody = { id: 'm1', org_id: 'org-1', project_id: 'org-1', project_name: null };
    memberships = [{ projectId: 'p1', projectName: 'A' }, { projectId: 'p2', projectName: 'B' }];
    expect(await shellProjectId()).toBe('org-1');
  });

  it('a claim that names one of the person\'s projects is kept as it is', async () => {
    meBody = { id: 'm1', org_id: 'org-1', project_id: 'p2', project_name: 'B' };
    memberships = [{ projectId: 'p1', projectName: 'A' }, { projectId: 'p2', projectName: 'B' }];
    expect(await shellProjectId()).toBe('p2');
  });
});
