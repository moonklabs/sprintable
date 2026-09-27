// @vitest-environment jsdom
/**
 * story #4370 — 데스크톱 전환기의 새 프로젝트 창: 설명(여러 줄)이 든 폼이라 폼 전체가 조직별 초안(훅 `useUnifiedSwitcher`).
 * Esc로 닫혀도 남고, 보이는 «취소»(배선 = clearNewProjectDraft)는 지운다. 모바일 칩(context-switcher-chip)과 같은 규칙 · 배선은 따로라 따로 고정.
 */
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }];
const PROJECTS = [{ projectId: 'proj-1', projectName: 'Sprintable' }];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
  const mem = new Map<string, string>();  // SidebarProvider가 폭을 localStorage에서 읽는다 — 이 환경엔 없다
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const nav = koMessages.nav as Record<string, string>;
const desc = () => document.body.querySelector('#unified-proj-desc') as HTMLTextAreaElement | null;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

async function openNewProject() {
  const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement;
  await act(async () => { trigger.click(); });
  await settle();
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === nav.switcherNewProject) as HTMLElement;
  await act(async () => { item.click(); });
  await settle();
}
async function type(text: string) {
  const el = desc()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('UnifiedSwitcher — 새 프로젝트 폼 초안 (story #4370)', () => {
  it('Esc로 닫혀도 설명이 남고 · 보이는 «취소»는 지운다', async () => {
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
    await type('카드 · 계좌 흐름 정리\n3분기 목표');
    await act(async () => { desc()!.focus(); });
    await act(async () => { esc(desc()!); });
    await act(async () => { esc(document.activeElement ?? document.body); });
    await settle();
    expect(desc()).toBeNull();
    await openNewProject();
    expect(desc()!.value).toBe('카드 · 계좌 흐름 정리\n3분기 목표');
    const dialog = desc()!.closest('[role="dialog"]')!;
    const cancel = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.common.cancel)!;
    await act(async () => { cancel.click(); });
    await settle();
    expect(desc()).toBeNull();
    await openNewProject();
    expect(desc()!.value).toBe('');
  });
});
