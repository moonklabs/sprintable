// @vitest-environment jsdom
//
// story 5036 (C6 · PO 11-27, the first real Mac-app walk's finding): an account with NO organization that opens the Mac app lands on the setup card — and never met the first-run line (① first project → ② the three
// ways → ③ the project's channel). The card hands such a person to /onboarding (which makes the organization behind the scene): the Mac app · no organization · no invitation · not a server host. One move.
import { EmbeddedServerProvider } from '@/components/embedded-server-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { ctx, sp, app } = vi.hoisted(() => ({ ctx: vi.fn(), sp: { value: null as URLSearchParams | null }, app: { in: true } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useSearchParams: () => sp.value }));
vi.mock('@/lib/ee', () => ({ isEEEnabled: () => false }));
vi.mock('@/lib/desktop-app', async (orig) => ({ ...(await orig<typeof import('@/lib/desktop-app')>()), desktopApp: () => (app.in ? ({ inApp: true } as never) : undefined) }));

import { DesktopSetupQuick } from './desktop-setup-quick';
import { parseSetupFragment } from '@/lib/desktop-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const HASH = `#code=${CODE}&setup=11111111-1111-4111-8111-aaaaaaaaaaaa&runtimes=claude,codex&caps=move,solo&rv=claude:2.1.289,codex:0.159.3`;
let container: HTMLDivElement;
let root: Root;
let invites: () => Response;
let replace: ReturnType<typeof vi.fn>;
let calls: string[];

const text = () => container.textContent ?? '';

async function mount(opts: { orgId?: string | null; serverHost?: boolean } = {}) {
  ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: opts.orgId === undefined ? null : opts.orgId, orgMemberships: [], projectMemberships: [] });
  const query = parseSetupFragment(HASH)!;
  await act(async () => {
    root.render(
      <EmbeddedServerProvider embedded={false}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query} onTeam={() => undefined} serverHost={opts.serverHost ?? false} /></NextIntlClientProvider>
      </EmbeddedServerProvider>,
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  app.in = true; calls = [];
  invites = () => new Response(JSON.stringify({ invites: [] }), { status: 200 });
  replace = vi.fn();
  vi.stubGlobal('location', { ...window.location, replace, assign: vi.fn(), pathname: '/desktop/setup', search: '', hash: '' } as unknown as Location);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/api/invites/mine')) return invites();
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { display_name: '김지우', email: 'a@b.c', email_verified: true, email_verification_required: true } }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('[SID:5036] an organization-less account in the Mac app goes to the first-run line', () => {
  it('the Mac app · no organization · no invitation → /onboarding, ONCE, with no `next` (reverted → the setup card «새 조직» is drawn and the line is never met)', async () => {
    await mount();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/onboarding');
    expect(String(replace.mock.calls[0]![0])).not.toContain('next');
    // while the page changes the card is not drawn: no «에이전트 만들기» form for an account that has no organization behind it
    expect(text()).not.toContain('에이전트 만들기');
  });

  it('the invitation list is read once — the hand-over is not a second round of reads', async () => {
    await mount();
    expect(calls.filter((u) => u.endsWith('/api/invites/mine')).length).toBe(1);
  });

  it('an invitation waiting → the card (the person joins that organization there), no move', async () => {
    invites = () => new Response(JSON.stringify({ invites: [{ id: 'i-1', org_id: 'o-9', org_name: '친구 조직', role: 'member', invited_by_name: '민', expires_at: '2099-01-01T00:00:00Z' }] }), { status: 200 });
    await mount();
    expect(replace).not.toHaveBeenCalled();
  });

  it('not the Mac app (the web) → the card as before, no move', async () => {
    app.in = false;
    await mount();
    expect(replace).not.toHaveBeenCalled();
    expect(text()).toContain('에이전트 만들기');
  });

  it('a server host → the card as before, no move (its onboarding has no first-run line)', async () => {
    await mount({ serverHost: true });
    expect(replace).not.toHaveBeenCalled();
    expect(text()).toContain('에이전트 만들기');
  });

  it('an invitation list that could not be read is not «none» → no move (the card says so and reads again)', async () => {
    invites = () => new Response('{}', { status: 500 });
    await mount();
    expect(replace).not.toHaveBeenCalled();
  });

  it('an account that already HAS an organization never asks (no invitation read, no move) — the setup card is its own page', async () => {
    await mount({ orgId: 'o-1' });
    expect(replace).not.toHaveBeenCalled();
    expect(calls.some((u) => u.endsWith('/api/invites/mine'))).toBe(false);
  });
});


describe('[SID:5036] a late «no invitation» answer does not hand over what is no longer a new account (codex)', () => {
  it('the account has an organization by the time the answer comes (the context refreshed) → no move', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    invites = () => { throw new Error('replaced'); };
    (globalThis as { fetch: unknown }).fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/api/invites/mine')) { await gate; return new Response(JSON.stringify({ invites: [] }), { status: 200 }); }
      return new Response('{}', { status: 404 });
    });
    await mount();
    expect(calls.some((u) => u.endsWith('/api/invites/mine'))).toBe(true); // in flight
    ctx.mockReturnValue({ projectId: undefined, currentProjectSlug: 'proj', userName: '김지우', orgId: 'o-1', orgMemberships: [], projectMemberships: [] });
    const query = parseSetupFragment(HASH)!;
    await act(async () => {
      root.render(<EmbeddedServerProvider embedded={false}><NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopSetupQuick query={query} onTeam={() => undefined} /></NextIntlClientProvider></EmbeddedServerProvider>);
    });
    release();
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(replace).not.toHaveBeenCalled(); // reverted (no org check at answer time) → a move to /onboarding for an account that has one
  });

  it('the page is gone when the answer comes → no move', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as { fetch: unknown }).fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/api/invites/mine')) { await gate; return new Response(JSON.stringify({ invites: [] }), { status: 200 }); }
      return new Response('{}', { status: 404 });
    });
    await mount();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    release();
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    expect(replace).not.toHaveBeenCalled();
  });
});
