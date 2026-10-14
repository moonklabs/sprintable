// @vitest-environment jsdom
// [SID:4681] (Yuna §K · PO 10-14 · live walk 7): the «새 프로젝트» dialog, when the plan's project limit refuses the create (402
// PLAN_LIMIT_EXCEEDED), says so — the organization dialog's warning banner (title · reason · the way to the billing tab) at the form's top
// instead of «잠시 후 다시 시도해 주세요» (a retry that can never work). What was typed and picked stays and [취소] leaves. Any other failure
// keeps the one general line. The mobile chip shares the hook and the banner component.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { SidebarProvider } from '@/components/ui/sidebar';
import { UnifiedSwitcher } from './unified-switcher';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/nav/create-organization-dialog', () => ({ CreateOrganizationDialog: () => null }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: async () => ({ ok: true, json: async () => ({ data: [] }) }) }));
const { appRef } = vi.hoisted(() => ({ appRef: { current: null as null | { pickFolder: () => Promise<string | null>; setProjectFolder: () => Promise<{ ok: true }> } } }));
vi.mock('@/lib/desktop-app', () => ({ desktopApp: () => appRef.current ?? undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }];
const PROJECTS = [{ projectId: 'proj-1', projectName: '발행 시험' }];
const nav = koMessages.nav as Record<string, string>;
const onb = koMessages.onboarding as unknown as Record<string, string>;
const GENERIC = nav.switcherCreateProjectError!;
let container: HTMLDivElement;
let root: Root;
let createAnswer: { ok: boolean; status: number; json: () => Promise<unknown> };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  appRef.current = { pickFolder: async () => '/Users/t/work/a', setProjectFolder: async () => ({ ok: true as const }) };
  createAnswer = { ok: false, status: 402, json: async () => ({ error: { code: 'PLAN_LIMIT_EXCEEDED', limit: 1, tier: 'free', resource: 'project', upgrade_required: true } }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => (url === '/api/projects' && init?.method === 'POST' ? createAnswer : { ok: true, json: async () => ({ data: [] }) })));
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <SidebarProvider>
          <UnifiedSwitcher orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />
        </SidebarProvider>
      </NextIntlClientProvider>,
    );
  });
}

/** open the dialog, type a name, pick a folder, press «만들기» */
async function fillAndSubmit() {
  const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  await act(async () => { trigger.click(); });
  await settle();
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === nav.switcherNewProject) as HTMLElement;
  await act(async () => { item.click(); });
  await settle();
  const dialog = document.body.querySelector('[role="dialog"]')!;
  const name = dialog.querySelector('#unified-proj-name') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'walk-p2');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { (dialog.querySelector('[data-testid="project-folder-pick"]') as HTMLButtonElement).click(); });
  await settle();
  await submit();
  return dialog;
}
async function submit() {
  const dialog = document.body.querySelector('[role="dialog"]')!;
  await act(async () => { (dialog.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
  await settle();
}

describe('«새 프로젝트» 창 — 요금제 프로젝트 한도(402) (story #4681 · Yuna §K)', () => {
  it('free: the warning banner replaces the general line — title · reason with the limit · the billing way; the typed name, the folder and the way out stay', async () => {
    await render();
    const dialog = await fillAndSubmit();
    const banner = dialog.querySelector('[data-testid="project-limit-banner"]')!;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.querySelectorAll('p.break-keep').length).toBe(2); // no global keep-all: a Korean line must not break inside a word (Yuna)
    expect(banner.textContent).toContain(nav.orgLimitBannerTitle);
    expect(banner.textContent).toContain(onb.projectLimitExceededError!.replace('{limit}', '1'));
    const link = banner.querySelector('a')!;
    expect(link.textContent).toBe(nav.orgLimitUpgradeLink);
    expect(link.getAttribute('href')).toContain('/settings?tab=billing');
    expect(dialog.textContent).not.toContain(GENERIC); // «잠시 후 다시 시도» is not said to a person a retry cannot help
    // at the form's top — before the name field
    expect(banner.compareDocumentPosition(dialog.querySelector('#unified-proj-name')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // nothing typed or picked is lost; the dialog is still open and [취소] is there
    expect((dialog.querySelector('#unified-proj-name') as HTMLInputElement).value).toBe('walk-p2');
    expect(dialog.querySelector('[data-testid="project-folder-path"]')!.textContent).toBe('~/work/a');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect([...dialog.querySelectorAll('button')].some((b) => b.textContent?.trim() === (koMessages.common as Record<string, string>).cancel)).toBe(true);
  });

  it('a tier that is not free: the other reason (no «무료 플랜»)', async () => {
    createAnswer = { ok: false, status: 402, json: async () => ({ error: { code: 'PLAN_LIMIT_EXCEEDED', limit: 5, tier: 'pro', resource: 'project' } }) };
    await render();
    const dialog = await fillAndSubmit();
    const banner = dialog.querySelector('[data-testid="project-limit-banner"]')!;
    expect(banner.textContent).toContain(onb.projectLimitExceededPaid!.replace('{limit}', '5'));
    expect(banner.textContent).not.toContain('무료 플랜');
  });

  it('en: the same banner in English', async () => {
    await render('en');
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
    await act(async () => { trigger.click(); });
    await settle();
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === (enMessages.nav as Record<string, string>).switcherNewProject) as HTMLElement;
    await act(async () => { item.click(); });
    await settle();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const name = dialog.querySelector('#unified-proj-name') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'x');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();
    expect(dialog.querySelector('[data-testid="project-limit-banner"]')!.textContent).toContain('Upgrade required');
  });

  it('every other failure keeps the one general line and no banner: a 500, a 403, a 402 for another resource, a network error', async () => {
    for (const answer of [
      { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR' } }) },
      { ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) },
      { ok: false, status: 402, json: async () => ({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'agent' } }) },
    ]) {
      createAnswer = answer;
      await render();
      const dialog = await fillAndSubmit();
      expect(dialog.querySelector('[data-testid="project-limit-banner"]')).toBeNull();
      expect(dialog.textContent).toContain(GENERIC);
      await act(async () => { root.unmount(); });
      container.remove();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => { if (url === '/api/projects') throw new Error('offline'); return { ok: true, json: async () => ({ data: [] }) }; });
    await render();
    const dialog = await fillAndSubmit();
    expect(dialog.querySelector('[data-testid="project-limit-banner"]')).toBeNull();
    expect(dialog.textContent).toContain(GENERIC);
  });

  it('a limit answer followed by another kind of failure: the banner goes, the general line comes (one at a time)', async () => {
    await render();
    const dialog = await fillAndSubmit();
    expect(dialog.querySelector('[data-testid="project-limit-banner"]')).not.toBeNull();
    createAnswer = { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR' } }) };
    await submit();
    expect(dialog.querySelector('[data-testid="project-limit-banner"]')).toBeNull();
    expect(dialog.textContent).toContain(GENERIC);
  });

  it('the order a customer really walks — limit → close → open again: no old banner and no general line (the open/close setter clears it)', async () => {
    await render();
    const dialog = await fillAndSubmit();
    expect(dialog.querySelector('[data-testid="project-limit-banner"]')).not.toBeNull();
    // close with the visible cancel button
    const cancel = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === (koMessages.common as Record<string, string>).cancel) as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // open the dialog again
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
    await act(async () => { trigger.click(); });
    await settle();
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === nav.switcherNewProject) as HTMLElement;
    await act(async () => { item.click(); });
    await settle();
    const again = document.body.querySelector('[role="dialog"]')!;
    expect(again).not.toBeNull();
    expect(again.querySelector('[data-testid="project-limit-banner"]')).toBeNull();
    expect(again.textContent).not.toContain(GENERIC);
    expect(again.querySelector('[role="alert"]')).toBeNull();
  });
});
