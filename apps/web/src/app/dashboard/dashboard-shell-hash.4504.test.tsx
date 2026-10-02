// @vitest-environment jsdom
//
// story 4504 (AC1 · PO 14:21Z): the shell's `?p=` normalization (useProjectSsot) replaced the address with `${pathname}?${sp}` —
// no `#`. A page that reads its values from the `#` (the desktop setup's `#code=…`, put in by the app in the same document) lost
// them when that replace landed first: the person saw «데스크톱 앱에서 열어 주세요» inside the app. The real hook, under a router
// whose replace is what lands in the address.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const nav = vi.hoisted(() => ({ replaced: [] as string[] }));
const router = vi.hoisted(() => ({
  replace: (url: string) => { nav.replaced.push(url); window.history.replaceState(null, '', url); },
  push: () => {},
  refresh: () => {},
  prefetch: () => {},
}));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
import { useProjectSsot } from './dashboard-shell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = 'proj-1';
const MEMBERSHIPS = [{ projectId: PROJECT, projectName: 'P' }];
function Shell() {
  useProjectSsot(PROJECT, MEMBERSHIPS, undefined); // a flat path (no path project) — /desktop/setup
  return null;
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
  window.history.replaceState(null, '', '/');
});

async function mount() {
  await act(async () => { root.render(<Shell />); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

describe('[SID:4504] the `?p=` normalization keeps the address `#`', () => {
  it('a page opened with values after `#` keeps them when the shell adds `?p=`', async () => {
    window.history.replaceState(null, '', '/desktop/setup#code=abc&setup=s-1&runtimes=codex');
    await mount();
    expect(nav.replaced).toEqual(['/desktop/setup?p=proj-1#code=abc&setup=s-1&runtimes=codex']);
    expect(window.location.hash).toBe('#code=abc&setup=s-1&runtimes=codex');
  });

  it('no `#` — the same replace as before (no stray `#`)', async () => {
    window.history.replaceState(null, '', '/desktop/setup');
    await mount();
    expect(nav.replaced).toEqual(['/desktop/setup?p=proj-1']);
  });
});
