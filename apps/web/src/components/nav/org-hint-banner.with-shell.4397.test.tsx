// @vitest-environment jsdom
//
// story #4397 (dev round, PO 00:20Z) — «a hint that is not offered is removed quietly» on a flat path without `?p=`. The shell's
// `?p=` normalization replaces the address in the same commit as the banner, from the search params it rendered with (the
// hint still in them), and the later replace wins. So the banner is tested **together with the real normalization hook**
// (useProjectSsot) under a router where the last replace of a commit is where the page lands — a banner-alone mock router
// cannot see this class.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const nav = vi.hoisted(() => ({ pathname: '/inbox', search: '', replaced: [] as string[] }));
const router = vi.hoisted(() => ({
  replace: (url: string) => { nav.replaced.push(url); },
  push: () => {},
  refresh: () => {},
  prefetch: () => {},
}));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const ctx = {
  projectMemberships: [], orgSyncPending: false, bottomDockBannerSlot: null, setBottomDockBannerSlot: () => {},
  orgId: 'org-a',
  orgMemberships: [
    { orgId: 'org-a', orgName: 'Moonklabs', orgSlug: 'moonklabs' },
    { orgId: '11111111-2222-4333-8444-555555555555', orgName: 'Heavaa', orgSlug: 'heavaahq' },
  ],
};
// The real context provider — not a module mock: dashboard-shell imports the banner itself, so a partial mock of this module
// never reaches the banner (it binds to the original through that cycle and sees an empty context).
import { DashboardCtx, useProjectSsot } from '@/app/dashboard/dashboard-shell';
import { OrgHintBanner } from './org-hint-banner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = 'proj-1';
const MEMBERSHIPS = [{ projectId: PROJECT, projectName: 'P' }];

function Normalizer() {
  useProjectSsot(PROJECT, MEMBERSHIPS, undefined); // flat path: no path project
  return null;
}

function Shell() {
  return (
    <DashboardCtx.Provider value={ctx}>
      <Normalizer />
      <OrgHintBanner />
    </DashboardCtx.Provider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  nav.replaced = [];
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><Shell /></NextIntlClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** Open `url`, then follow navigation: each round the last replace of the commit is where the page lands. */
async function openAndSettle(url: string): Promise<URL> {
  const start = new URL(url, 'http://t');
  nav.pathname = start.pathname;
  nav.search = start.search.replace(/^\?/, '');
  await render();
  for (let round = 0; round < 8 && nav.replaced.length > 0; round++) {
    const landed = new URL(nav.replaced[nav.replaced.length - 1], 'http://t');
    nav.replaced = [];
    nav.pathname = landed.pathname;
    nav.search = landed.search.replace(/^\?/, '');
    await render();
  }
  expect(nav.replaced).toEqual([]); // settled
  return new URL(`${nav.pathname}?${nav.search}`, 'http://t');
}

describe('[SID:4397] a hint that is not offered is removed even while the shell normalizes `?p=`', () => {
  it.each([
    ['an org they are not in', '99999999-2222-4333-8444-555555555555'],
    ['an empty hint', ''],
    ['the current org', 'org-a'],
  ])('%s — without `?p=` (the shell adds it in the same commit)', async (_label, hint) => {
    const landed = await openAndSettle(`/inbox?tab=gates&org_id=${hint}`);
    expect(landed.searchParams.has('org_id')).toBe(false);
    expect(landed.searchParams.get('p')).toBe(PROJECT);
    expect(landed.searchParams.get('tab')).toBe('gates');
  });

  it.each([
    ['an org they are not in', '99999999-2222-4333-8444-555555555555'],
    ['the current org', 'org-a'],
  ])('%s — with `?p=` already (the shell leaves the address alone)', async (_label, hint) => {
    const landed = await openAndSettle(`/inbox?tab=gates&p=${PROJECT}&org_id=${hint}`);
    expect(landed.searchParams.has('org_id')).toBe(false);
    expect(landed.searchParams.get('p')).toBe(PROJECT);
  });

  it('another org of theirs: the card stays offered (the hint is kept for the switch)', async () => {
    const landed = await openAndSettle('/inbox?tab=gates&org_id=11111111-2222-4333-8444-555555555555');
    expect(landed.searchParams.get('org_id')).toBe('11111111-2222-4333-8444-555555555555');
    expect(container.querySelector('[data-testid="org-hint-banner"]')).not.toBeNull();
  });
});
