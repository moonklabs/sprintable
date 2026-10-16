// @vitest-environment jsdom
//
// story 4670 (UX-1 · U2 · AC3 · AC3-보안) — /desktop/remote-on: opening it changes NOTHING; [켜기] is the only thing that turns the org's
// «원격 제어» on, wherever the page was opened (Kadir's lens 10-14). The org is the session's, named beside the button — never one taken
// from the address. `#then=pair` is a closed set of one. Members get the existing «조직 소유자가 켜면…» line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { __resetOrgRemoteControlForTest } from '@/lib/org-remote-control';

const { ctx, sp } = vi.hoisted(() => ({ ctx: vi.fn(), sp: { value: null as URLSearchParams | null } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useSearchParams: () => sp.value }));

import { DesktopRemoteOn, appNav, thenFromFragment } from './desktop-remote-on';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OFF_OWNER = { enabled: false, can_change: true, enabled_at: null };
let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method: string; body?: unknown }[];
let getNow: () => Response;
let putNow: () => Response;
const json = (data: object, status = 200) => new Response(JSON.stringify({ data }), { status });
const puts = () => calls.filter((c) => c.method === 'PUT');
const q = (id: string) => container.querySelector(`[data-testid=${id}]`);

async function flush() { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); }
async function mountPage(opts: { hash?: string; search?: string; orgId?: string; orgs?: { orgId: string; orgName: string; orgSlug: string; role: string }[] } = {}) {
  // a fresh page each time (a second call in one test is a second visit — no state carried over)
  await act(async () => { root.unmount(); });
  root = createRoot(container);
  __resetOrgRemoteControlForTest();
  window.history.replaceState(null, '', `/desktop/remote-on${opts.search ?? ''}${opts.hash ?? ''}`);
  sp.value = new URLSearchParams(opts.search ?? '');
  ctx.mockReturnValue({ orgId: opts.orgId ?? 'o-1', orgMemberships: opts.orgs ?? [{ orgId: 'o-1', orgName: '뭉클랩 본사', orgSlug: 'moonk', role: 'owner' }, { orgId: 'o-evil', orgName: '다른 조직', orgSlug: 'other', role: 'owner' }] });
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopRemoteOn /></NextIntlClientProvider>);
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  getNow = () => json(OFF_OWNER);
  putNow = () => json({ enabled: true, can_change: true, enabled_at: 'now' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (/\/api\/organizations\/[^/]+\/remote-control$/.test(url)) return init?.method === 'PUT' ? putNow() : getNow();
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop;
  __resetOrgRemoteControlForTest();
});

describe('[SID:4670] thenFromFragment — a closed set of one', () => {
  it('«pair» → pair · anything else, or nothing → null (no free string ever reaches a link)', () => {
    expect(thenFromFragment('#then=pair')).toBe('pair');
    expect(thenFromFragment('then=pair&x=1')).toBe('pair');
    for (const bad of ['', '#', '#then=', '#then=Pair', '#then=pair2', '#then=https://evil.example', '#then=/desktop/setup', '#then=pair%20', '#other=pair']) expect(thenFromFragment(bad), bad).toBeNull();
  });
});

describe('[SID:4670] AC3-보안 — opening the page switches nothing (the bridge or not · the way back or not)', () => {
  it('a browser (no bridge): the page asks — [켜기] with the org beside it — and sends no PUT by itself', async () => {
    await mountPage({ hash: '#then=pair' });
    expect(q('remote-on-ask')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('원격 제어 켜기');
    expect(container.textContent).toContain('켜면 페어링된 폰에서 에이전트를 멈추고, 지시하고, 권한 요청에 답할 수 있어요. 이 조직 전체에 적용돼요.');
    expect(q('remote-on-org')?.textContent).toBe('조직: 뭉클랩 본사');
    expect(q('remote-on-press')?.textContent).toBe('켜기');
    expect(puts()).toHaveLength(0); // reverted (auto-PUT on open) → fails
  });

  it('no org name known (the membership list has no such org): the page does not ask — a loading card, no [켜기], no PUT (the one promise is the name beside the button)', async () => {
    await mountPage({ orgs: [{ orgId: 'o-other', orgName: '다른 조직', orgSlug: 'other', role: 'owner' }] });
    expect(q('remote-on-ask')).toBeNull();
    expect(q('remote-on-press')).toBeNull();
    expect(container.querySelector('[aria-label]')).not.toBeNull(); // the spinner card
    expect(puts()).toHaveLength(0);
  });

  it('a long name with no break points wraps inside the card (overflow-wrap:anywhere) — the org line never pushes the card wider (유나 비차단 ②)', async () => {
    await mountPage({ orgs: [{ orgId: 'o-1', orgName: 'ㅁ'.repeat(60) + 'Averyveryveryverylongorganizationname'.repeat(3), orgSlug: 'x', role: 'owner' }] });
    expect(q('remote-on-org')?.className).toContain('[overflow-wrap:anywhere]');
    expect(q('remote-on-org')?.textContent).toContain('Averyveryveryverylongorganizationname'); // not cut
  });

  it('inside the app (the bridge is there): STILL no PUT — the bridge does not say who asked, a link in a chat opens the same page', async () => {
    (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = Object.freeze({
      inApp: true, device: { name: 'mac' }, runtimes: [], pickFolder: async () => null, startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }),
    });
    await mountPage({ hash: '#then=pair' });
    await flush();
    expect(q('remote-on-ask')).not.toBeNull();
    expect(puts()).toHaveLength(0);
  });
});

describe('[SID:4670] AC3 — [켜기] is the one trigger; the org is the session\'s', () => {
  it('[켜기] → ONE PUT {enabled:true} for the session org; then «원격 제어를 켰어요» (no way back asked → no hand-over)', async () => {
    const nav = vi.spyOn(appNav, 'to').mockImplementation(() => undefined);
    await mountPage();
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ url: '/api/organizations/o-1/remote-control', body: { enabled: true } });
    expect(q('remote-on-done')?.textContent).toBe('원격 제어를 켰어요');
    expect(q('remote-on-back')).toBeNull();
    expect(nav).not.toHaveBeenCalled();
  });

  it('with #then=pair: «켰어요 — 앱으로 돌아가요» and, a second later, the hand-over to the app\'s pairing (a link) — [앱으로] is there too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const nav = vi.spyOn(appNav, 'to').mockImplementation(() => undefined);
      await mountPage({ hash: '#then=pair' });
      await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
      await flush();
      expect(q('remote-on-done')?.textContent).toContain('켰어요 — 앱으로 돌아가요');
      expect(q('remote-on-back')?.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=pair');
      expect(nav).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(nav).toHaveBeenCalledTimes(1);
      expect(nav).toHaveBeenCalledWith('ai.sprintable:/desktop/setup?intent=pair');
    } finally { vi.useRealTimers(); }
  });

  it('an organization named in the address changes nothing: the PUT goes to the session\'s org and that org\'s name is the one beside [켜기]', async () => {
    await mountPage({ search: '?org=o-evil&orgId=o-evil&organization=o-evil', hash: '#org=o-evil&then=pair' });
    expect(q('remote-on-org')?.textContent).toBe('조직: 뭉클랩 본사');
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(puts().map((c) => c.url)).toEqual(['/api/organizations/o-1/remote-control']);
    expect(calls.some((c) => c.url.includes('o-evil'))).toBe(false);
  });

  it('only «then=pair» opens a way back: another value → no [앱으로] and no hand-over, whatever it says', async () => {
    const nav = vi.spyOn(appNav, 'to').mockImplementation(() => undefined);
    await mountPage({ hash: '#then=https://evil.example/x' });
    expect(q('remote-on-back')).toBeNull();
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(q('remote-on-back')).toBeNull();
    expect(nav).not.toHaveBeenCalled();
  });

  it('the app named by ?app=check gets its own scheme in the way back (the closed table)', async () => {
    await mountPage({ search: '?app=check', hash: '#then=pair' });
    expect(q('remote-on-back')?.getAttribute('href')).toBe('ai.sprintable.check:/desktop/setup?intent=pair');
    await mountPage({ search: '?app=whatever', hash: '#then=pair' });
    expect(q('remote-on-back')?.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=pair');
  });

  it('a refused switch says so (role=alert) and [켜기] stays to press again — a second press sends a second PUT, never two at once', async () => {
    putNow = () => new Response('{}', { status: 500 });
    await mountPage();
    const press = q('remote-on-press') as HTMLButtonElement;
    await act(async () => { press.click(); });
    await flush();
    expect(q('remote-on-failed')?.textContent).toBe('켜지 못했어요 — 잠시 뒤 다시 눌러 주세요');
    expect(puts()).toHaveLength(1);
    putNow = () => json({ enabled: true, can_change: true, enabled_at: 'now' });
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(puts()).toHaveLength(2);
    expect(q('remote-on-done')).not.toBeNull();
  });
});

describe('[SID:4670] AC3 — the server says «not the owner» at the press (the owner seat was lost after the page opened)', () => {
  const refuse = (code: string, status = 403) => () => new Response(JSON.stringify({ data: null, error: { code, message: 'refused' } }), { status });

  it('403 owner_required → the existing «조직 소유자(…)가 켜면…» line with the owner names, [켜기] gone (the server\'s answer shown as it is); the way back only with #then=pair', async () => {
    getNow = () => json({ ...OFF_OWNER, owner_names: ['김지우'] });
    putNow = refuse('owner_required');
    await mountPage({ hash: '#then=pair' });
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(q('remote-on-not-owner')?.textContent).toContain('조직 소유자(김지우)가 켜면 다시 할 수 있어요');
    expect(q('remote-on-press')).toBeNull(); // reverted (the generic failure line) → fails
    expect(q('remote-on-failed')).toBeNull();
    expect(q('remote-on-back')?.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=pair');
    expect(puts()).toHaveLength(1);
  });

  it('any other refusal stays the one failure line with [켜기] to press again (a 403 that is not owner_required · a 500)', async () => {
    getNow = () => json({ ...OFF_OWNER, owner_names: ['김지우'] });
    putNow = refuse('person_session_required');
    await mountPage();
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(q('remote-on-failed')?.textContent).toBe('켜지 못했어요 — 잠시 뒤 다시 눌러 주세요');
    expect(q('remote-on-press')).not.toBeNull();
    expect(q('remote-on-not-owner')).toBeNull();
    putNow = () => new Response('{}', { status: 500 });
    await act(async () => { (q('remote-on-press') as HTMLButtonElement).click(); });
    await flush();
    expect(q('remote-on-failed')).not.toBeNull();
    expect(q('remote-on-not-owner')).toBeNull();
  });
});

describe('[SID:4670] AC3 — not the person who can switch it · already on', () => {
  it('a member (cannot change · off): the existing «조직 소유자가 켜면…» line with the owner\'s name, no [켜기], no PUT — and [앱으로] only with the way back', async () => {
    getNow = () => json({ enabled: false, can_change: false, enabled_at: null, owner_names: ['김지우'] });
    await mountPage({ hash: '#then=pair' });
    expect(q('remote-on-not-owner')?.textContent).toContain('조직 소유자(김지우)가 켜면 다시 할 수 있어요');
    expect(q('remote-on-press')).toBeNull();
    expect(q('remote-on-back')?.getAttribute('href')).toBe('ai.sprintable:/desktop/setup?intent=pair');
    expect(puts()).toHaveLength(0);
    await mountPage();
    expect(q('remote-on-back')).toBeNull();
  });

  it('already on: with the way back → «이미 켜져 있어요 — 앱으로 돌아가요» and the hand-over (a link · no PUT) · without → «원격 제어가 이미 켜져 있어요», nowhere to go', async () => {
    getNow = () => json({ enabled: true, can_change: true, enabled_at: 'x' });
    const nav = vi.spyOn(appNav, 'to').mockImplementation(() => undefined);
    await mountPage({ hash: '#then=pair' });
    expect(q('remote-on-already')?.textContent).toContain('이미 켜져 있어요 — 앱으로 돌아가요');
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith('ai.sprintable:/desktop/setup?intent=pair');
    expect(puts()).toHaveLength(0);
    nav.mockClear();
    await mountPage();
    expect(q('remote-on-already')?.textContent).toContain('원격 제어가 이미 켜져 있어요');
    expect(nav).not.toHaveBeenCalled();
    expect(q('remote-on-back')).toBeNull();
  });
});

describe('[SID:4670] ⓑ the page cannot step out of the frame-denying header (X-Frame-Options: DENY on every path)', () => {
  it('next.config sends X-Frame-Options DENY for «/(.*)» and carves no path out — so /desktop/remote-on cannot be put in someone else\'s frame', async () => {
    vi.resetModules();
    const config = (await import('../../../next.config')).default as { headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rules = (await config.headers?.()) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.source === '/(.*)')).toBe(true);
    for (const r of rules) {
      // a per-path rule may exist (story 4712: the two code-carrying /native pages add no-referrer · no-store) but it must carry the ban too —
      // no path is left out of it
      expect(r.headers.find((h) => h.key === 'X-Frame-Options')?.value).toBe('DENY');
    }
  });
});
