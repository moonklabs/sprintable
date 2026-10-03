// @vitest-environment jsdom
//
// story #4535 (PO 18:58Z · 미르코 실측 combined-r3/1-chip-on.png) — on /desktop the switch card and «원격 기기» show ONE value of the
// org's «원격 제어»: turning it on takes «원격 기기»'s «꺼져 있어요» line away at once, turning it off brings it back, with no reload
// and one read; a failed change moves neither.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: '문클랩스' }] }) }));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'Asia/Seoul' }));
const { DesktopRemoteControlCard } = await import('./desktop-remote-control-card');
const { DesktopRemoteDevices } = await import('./desktop-remote-devices');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const state = (enabled: boolean) => ({ data: { enabled, enabled_at: enabled ? '2026-10-03T09:00:00Z' : null, can_change: true } });

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

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => container.textContent ?? '';
const sw = () => container.querySelector<HTMLElement>('[data-slot="switch"]')!;
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!;
const OFF_LINE = '지금 조직(문클랩스)은 원격 제어가 꺼져 있어요';

function server(put: (enabled: boolean) => Response) {
  let enabled = false;
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/remote-devices') return json({ devices: [] });
    if (init?.method === 'PUT') {
      const want = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      const res = put(want);
      if (res.ok) enabled = want;
      return res;
    }
    return json(state(enabled));
  });
}

async function render() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DesktopRemoteControlCard />
        <DesktopRemoteDevices />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

const reads = () => fetchWithAuth.mock.calls.filter(([url, init]) => url === '/api/organizations/org-1/remote-control' && !init).length;

describe('the switch and «원격 기기» see one value (story #4535)', () => {
  it('on: the «꺼져 있어요» line goes at once · off: it comes back — one read, no reload', async () => {
    server((enabled) => json(state(enabled)));
    await render();
    expect(reads()).toBe(1);
    expect(text()).toContain(OFF_LINE);

    await act(async () => { sw().click(); });
    await flush();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain(OFF_LINE);

    await act(async () => { sw().click(); });
    await act(async () => { button('끄기').click(); });
    await flush();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain(OFF_LINE);
    expect(reads()).toBe(1);
  });

  it('a failed change moves neither', async () => {
    server(() => json({ data: null, error: { code: 'x' } }, 500));
    await render();
    await act(async () => { sw().click(); });
    await flush();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain(OFF_LINE);
    expect(text()).toContain('바꾸지 못했어요');
  });
});
