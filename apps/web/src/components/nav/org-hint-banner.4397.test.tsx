// @vitest-environment jsdom
//
// story #4397 — the org hint of a push notification. The switch is offered, never automatic (switching revokes the person's
// refresh tokens on every device — a page GET must not do it). After the switch the person lands on the notification's own
// path (Yuna: the body «전환하면 이어서 열려요» holds only then).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const nav = vi.hoisted(() => ({ search: '', pathname: '/gates/g-1', replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const ctx = vi.hoisted(() => ({ orgId: 'org-a', orgMemberships: [] as { orgId: string; orgName: string; orgSlug: string }[] }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));

import { OrgHintBanner } from './org-hint-banner';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG_A = 'org-a';
const ORG_B = '11111111-2222-4333-8444-555555555555';
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function mount(search: string, pathname = '/gates/g-1') {
  nav.search = search;
  nav.pathname = pathname;
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgHintBanner /></NextIntlClientProvider>);
  });
}

const banner = () => container.querySelector('[data-testid="org-hint-banner"]');
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

beforeEach(() => {
  nav.replace.mockReset();
  nav.refresh.mockReset();
  ctx.orgId = ORG_A;
  ctx.orgMemberships = [
    { orgId: ORG_A, orgName: 'Moonklabs', orgSlug: 'moonklabs' },
    { orgId: ORG_B, orgName: 'Heavaa', orgSlug: 'heavaahq' },
  ];
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'proj-of-org-a');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('[SID:4397] OrgHintBanner', () => {
  it('another org of theirs: the card is offered, and opening the page alone never switches', async () => {
    await mount(`org_id=${ORG_B}`);
    expect(banner()?.textContent).toContain('다른 조직의 알림');
    expect(banner()?.textContent).toContain('Heavaa');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('pressing the switch POSTs once and lands on the notification path without the hint (other query kept)', async () => {
    await mount(`tab=gates&org_id=${ORG_B}`, '/inbox');
    await act(async () => { button(koMessages.nav.switcherSwitchToOrg).click(); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/switch-org');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ org_id: ORG_B });
    expect(nav.replace).toHaveBeenCalledWith('/inbox?tab=gates');
    expect(nav.refresh).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['an org they are not in', `org_id=99999999-2222-4333-8444-555555555555`],
    ['the current org', `org_id=${ORG_A}`],
    ['a malformed hint', 'org_id=not-a-uuid'],
  ])('%s: no card, the hint is removed quietly, no switch', async (_label, search) => {
    await mount(search);
    expect(banner()).toBeNull();
    expect(nav.replace).toHaveBeenCalledWith('/gates/g-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no hint: nothing happens', async () => {
    await mount('');
    expect(banner()).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a failed switch keeps the card, says so, and does not move', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: {} }), { status: 403 }));
    await mount(`org_id=${ORG_B}`);
    await act(async () => { button(koMessages.nav.switcherSwitchToOrg).click(); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(banner()?.textContent).toContain(koMessages.nav.switcherSwitchOrgError);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('closing only removes the hint', async () => {
    await mount(`org_id=${ORG_B}`);
    await act(async () => { button(koMessages.common.close).click(); });
    expect(nav.replace).toHaveBeenCalledWith('/gates/g-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('valid markup: nothing block-level inside the <p> title and description (PO 20:30Z ①)', async () => {
    await mount(`org_id=${ORG_B}`);
    expect(banner()!.querySelectorAll('p p, p div, p button').length).toBe(0);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: {} }), { status: 403 }));
    await act(async () => { button(koMessages.nav.switcherSwitchToOrg).click(); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(banner()!.querySelectorAll('p p, p div, p button').length).toBe(0); // with the error line too
  });

  it('an empty `?org_id=` is removed quietly (PO 20:30Z ②)', async () => {
    await mount('org_id=');
    expect(banner()).toBeNull();
    expect(nav.replace).toHaveBeenCalledWith('/gates/g-1');
  });

  it('the switch lands on the path the notification gave, even if the shell added its own query since (PO 20:30Z ③)', async () => {
    await mount(`tab=gates&org_id=${ORG_B}`, '/inbox');
    nav.search = `tab=gates&p=proj-x&org_id=${ORG_B}`; // the shell adds ?p= before the press
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgHintBanner /></NextIntlClientProvider>);
    });
    await act(async () => { button(koMessages.nav.switcherSwitchToOrg).click(); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(nav.replace).toHaveBeenCalledWith('/inbox?tab=gates');
  });
});

