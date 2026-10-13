// @vitest-environment jsdom
// [SID:4681] (D3 · piece ② · AC3): the sidebar's new-project dialog, on the web (not in the app), has the «접근 줄 에이전트» check list
// and no folder field (the folder field is the app's — piece ③ · D1). The mobile chip shares the hook and the same picker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SidebarProvider } from '@/components/ui/sidebar';
import { UnifiedSwitcher } from './unified-switcher';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/nav/create-organization-dialog', () => ({ CreateOrganizationDialog: () => null }));
const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }];
const PROJECTS = [{ projectId: 'proj-1', projectName: 'Sprintable' }];
const AGENTS = [{ id: 'a-1', name: '민 레', is_active: true, runtime_type: 'claude-code' }];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
  fetchWithAuth.mockImplementation(async (url: string) => (url === '/api/team-members?type=agent' ? { ok: true, json: async () => ({ data: AGENTS }) } : { ok: true, json: async () => ({ data: [] }) }));
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const nav = koMessages.nav as Record<string, string>;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

async function openNewProject() {
  const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  await act(async () => { trigger.click(); });
  await settle();
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === nav.switcherNewProject) as HTMLElement;
  await act(async () => { item.click(); });
  await settle();
}

describe('UnifiedSwitcher — 새 프로젝트 창의 접근 체크 목록 (story #4681 · AC3 web)', () => {
  it('the dialog has the check list (every box off) and no folder field', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <SidebarProvider>
            <UnifiedSwitcher orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />
          </SidebarProvider>
        </NextIntlClientProvider>,
      );
    });
    await openNewProject();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-testid="project-access-picker"]')).not.toBeNull();
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('[data-testid="project-access-checkbox"]')];
    expect(boxes.map((b) => b.getAttribute('data-agent-id'))).toEqual(['a-1']);
    expect(boxes[0]!.checked).toBe(false);
    expect(dialog.querySelector('[data-testid="project-folder-field"]')).toBeNull(); // app only · piece ③
    // the two inputs that were there stay
    expect(dialog.querySelector('#unified-proj-name')).not.toBeNull();
    expect(dialog.querySelector('#unified-proj-desc')).not.toBeNull();
  });
});
