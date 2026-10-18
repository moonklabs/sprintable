// @vitest-environment jsdom
//
// story 4711 AC4 — the invited card in the app's setup page: «내 조직을 새로 만들기» opens the new-organization window (the generic organization route, which has no pending-invite
// check), then the person is switched into the organization they made and the page is read again. A switch that does not go through keeps the made organization: the link tries
// the switch again, it does not make a second organization, and the person sees the failure line.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ userName: '지우' }) }));
vi.mock('@/components/nav/create-organization-dialog', () => ({
  // the real window closes itself when the organization is made, then reports it
  CreateOrganizationDialog: ({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) =>
    open ? <button type="button" data-testid="dialog-create" onClick={() => { onOpenChange(false); onCreated('org-new'); }}>만들기</button> : null,
}));

import { InvitedInApp, type MyInvite } from './desktop-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
void enMessages;

const A: MyInvite = { invite_id: '11111111-1111-4111-8111-111111111111', org_id: 'org-a', org_name: '뭉클랩', role: 'member', expires_at: '2099-10-06T12:00:00Z' };

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; body?: string }[];
let switchOk: boolean;
let onReload: Mock<() => void>;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  calls = []; switchOk = true; onReload = vi.fn<() => void>();
  window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'old-project');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url === '/api/switch-org') return new Response(JSON.stringify({ data: { ok: switchOk } }), { status: switchOk ? 200 : 500 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

async function mount() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><InvitedInApp invites={[A]} onReload={onReload} /></NextIntlClientProvider>);
  });
}
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const link = () => container.querySelector('[data-testid=setup-invited-own-org]') as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const switches = () => calls.filter((c) => c.url === '/api/switch-org');

describe('story 4711 AC4 — «내 조직을 새로 만들기» in the app', () => {
  it('opens the new-organization window; once made, the person is switched into it, the tab project is dropped and the page is read again', async () => {
    await mount();
    expect(container.querySelector('[data-testid=dialog-create]')).toBeNull();
    await click(link());
    await click(container.querySelector('[data-testid=dialog-create]')!);
    expect(switches()).toHaveLength(1);
    expect(JSON.parse(switches()[0]!.body!)).toEqual({ org_id: 'org-new' });
    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBeNull();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => /accept/.test(c.url))).toBe(false);                  // no invite is taken on this road
  });

  it('a switch that did not go through: the failure line shows, the page is NOT read again, and the link switches into the SAME organization again (no window, no second one)', async () => {
    switchOk = false;
    await mount();
    await click(link());
    await click(container.querySelector('[data-testid=dialog-create]')!);
    const line = container.querySelector('[data-testid=setup-invited-own-org-failed]')!;
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toContain('들어가지 못했어요 — 다시 눌러 주세요');
    expect(onReload).not.toHaveBeenCalled();
    switchOk = true;
    await click(link());
    expect(container.querySelector('[data-testid=dialog-create]')).toBeNull();     // the window did not open again
    expect(switches()).toHaveLength(2);
    expect(switches().map((c) => JSON.parse(c.body!).org_id)).toEqual(['org-new', 'org-new']);
    expect(container.querySelector('[data-testid=setup-invited-own-org-failed]')).toBeNull();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('while the switch is on its way the link is off', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res; })));
    await mount();
    await click(link());
    await act(async () => { (container.querySelector('[data-testid=dialog-create]') as HTMLElement).click(); });
    expect(link().disabled).toBe(true);
    await act(async () => { release(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })); });
    await flush();
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
