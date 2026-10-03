// @vitest-environment jsdom
//
// story #4535 AC1 — the org's «원격 제어» card on /desktop (Yuna's spec B-1 ①): an owner switches it (on: no confirmation ·
// off: the in-line confirmation, [취소] focused first), everyone else reads the state as it is, «{날짜}부터 켜져 있어요» when on,
// a failed change leaves the switch where it was with one line, a 403 turns the card into the owner line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId: 'org-1' }) }));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'Asia/Seoul' }));
const { DesktopRemoteControlCard } = await import('./desktop-remote-control-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response(JSON.stringify({ data: null, error: { code: 'x' } }), { status: code });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchWithAuth.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DesktopRemoteControlCard />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => container.textContent ?? '';
const sw = () => container.querySelector<HTMLElement>('[data-slot="switch"]');
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!;

describe('DesktopRemoteControlCard (story #4535)', () => {
  it('an owner sees the switch off by default and turns it on without a confirmation', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: false, enabled_at: null, can_change: true }));
    await render();
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/api/organizations/org-1/remote-control');
    expect(text()).toContain('원격 제어');
    expect(text()).toContain('허용되는 일: 지시 · 권한 응답 · 멈춤'); // story #4534 — start is a later card (PO 16:14Z)
    expect(sw()?.getAttribute('aria-checked')).toBe('false');

    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: true, enabled_at: '2026-10-03T09:00:00Z', can_change: true }));
    await act(async () => { sw()!.click(); });
    await flush();
    expect(fetchWithAuth.mock.calls[1]).toEqual(['/api/organizations/org-1/remote-control', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true }) })]);
    expect(sw()?.getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain('10월 3일부터 켜져 있어요'); // the device list's form (no year within this year · Yuna 12:53Z)
  });

  it('turning off asks in the line first ([취소] focused) and sends nothing until [끄기]', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: true, enabled_at: '2026-10-03T09:00:00Z', can_change: true }));
    await render();
    await act(async () => { sw()!.click(); });
    expect(text()).toContain('끄면 짝지은 기기에서 이 조직의 에이전트를 바로 제어할 수 없어요 — 짝은 그대로 남아요');
    expect(document.activeElement?.textContent).toBe('취소');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    await act(async () => { button('취소').click(); });
    expect(text()).not.toContain('끄면 짝지은');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(sw()); // the confirmation closed — focus back on the switch (Yuna 12:43Z)

    await act(async () => { sw()!.click(); });
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: false, enabled_at: null, can_change: true }));
    await act(async () => { button('끄기').click(); });
    await flush();
    expect(fetchWithAuth.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) }));
    expect(sw()?.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(sw());
  });

  it('someone else reads the state as it is — on is never said as off — and has no switch', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: true, enabled_at: '2026-10-03T09:00:00Z', can_change: false }));
    await render();
    expect(sw()).toBeNull();
    expect(text()).toContain('원격 제어 · 켜짐 — 조직 소유자만 켜고 끌 수 있어요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: false, enabled_at: null, can_change: false }));
    await render();
    expect(text()).toContain('원격 제어 · 꺼짐 — 조직 소유자만 켜고 끌 수 있어요');
  });

  it('a failed change leaves the switch where it was with one line; a 403 turns the card into the owner line', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: false, enabled_at: null, can_change: true }));
    await render();
    const live = container.querySelector('[role="status"]');
    expect(live?.textContent).toBe(''); // the status is there before anything fails — only its words change
    fetchWithAuth.mockResolvedValueOnce(status(500));
    await act(async () => { sw()!.click(); });
    await flush();
    expect(sw()?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain('바꾸지 못했어요 — 다시 시도해 주세요');
    expect(container.querySelector('[role="status"]')).toBe(live);
    expect(live?.textContent).toBe('바꾸지 못했어요 — 다시 시도해 주세요');

    fetchWithAuth.mockResolvedValueOnce(status(403));
    await act(async () => { sw()!.click(); });
    await flush();
    expect(sw()).toBeNull();
    expect(text()).toContain('원격 제어 · 꺼짐 — 조직 소유자만 켜고 끌 수 있어요');
  });

  it('nothing is drawn when the state cannot be read', async () => {
    fetchWithAuth.mockResolvedValueOnce(status(404));
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('en', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ enabled: false, enabled_at: null, can_change: false }));
    await render('en');
    expect(text()).toContain('Remote control · off — only organization owners can turn it on or off');
  });
});
