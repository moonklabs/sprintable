// @vitest-environment jsdom
//
// story 4713 AC3 — the block is really inside BOTH «새 프로젝트» dialogs (the sidebar's UnifiedSwitcher and the <1024 top-bar chip), above
// the name field, and the dialog is otherwise unchanged: the name field, the one [만들기] primary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SidebarProvider } from '@/components/ui/sidebar';
import { UnifiedSwitcher } from './unified-switcher';
import { ContextSwitcherChip } from './context-switcher-chip';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/nav/create-organization-dialog', () => ({ CreateOrganizationDialog: () => null }));
vi.mock('@/lib/desktop-app', () => ({ desktopApp: () => undefined }));
vi.mock('@/lib/org-remote-control', () => ({
  useOrgRemoteControl: () => [{ connected_setups: 1 }, () => {}, false],
  connectedSetupsOf: (s: { connected_setups?: number }) => s.connected_setups ?? 0,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }];
const PROJECTS = [{ projectId: 'proj-1', projectName: 'Sprintable' }];
const nav = koMessages.nav as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: PROJECTS.map((p) => ({ id: p.projectId, name: p.projectName })) }) })));
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0 });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function checkDialog(nameId: string) {
  const dialog = document.body.querySelector(`#${nameId}`)!.closest('[role="dialog"]')!; // the chip has its sheet open behind: the dialog is the one with the name field
  const block = dialog.querySelector('[data-testid=new-project-mac-block]')!;
  expect(block).not.toBeNull();
  expect(block.textContent).toContain('Mac 앱에서 폴더로 시작할 수도 있어요');
  const name = dialog.querySelector(`#${nameId}`)!;
  expect(name).not.toBeNull();
  // the block sits above the name field
  expect(block.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // the dialog keeps its one primary: the block's button is not a submit and not the filled variant
  const submit = dialog.querySelectorAll('button[type="submit"]');
  expect(submit).toHaveLength(1);
  expect(submit[0]!.textContent).toBe(nav.switcherCreateButton);
  expect(block.querySelector('button[type="submit"]')).toBeNull();
}

describe('story 4713 AC3 — the block inside both dialogs', () => {
  it('the sidebar switcher\'s dialog', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SidebarProvider><UnifiedSwitcher orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" /></SidebarProvider></NextIntlClientProvider>);
    });
    await act(async () => { (container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement).click(); });
    await settle();
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === nav.switcherNewProject) as HTMLElement;
    await act(async () => { item.click(); });
    await settle();
    checkDialog('unified-proj-name');
  });

  it('the top-bar chip\'s dialog', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" /></NextIntlClientProvider>);
    });
    await act(async () => { container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const item = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === nav.switcherNewProject)!;
    await act(async () => { item.click(); });
    await settle();
    checkDialog('chip-proj-name');
  });
});
