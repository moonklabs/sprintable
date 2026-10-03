// @vitest-environment jsdom
//
// story #4533 AC3 (명세 모음 «B-1 ③ 웹 내 설정 · 원격 기기 — 목록과 [빼기]만») — one line per phone ↔ computer pair with its
// confirmation number; [빼기] confirms in line ([취소] focused first) and says what happened with the right particle; empty and
// «remote control off» lines; the web has no pairing button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: '문클랩스', orgSlug: 'mk' }] }),
}));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'Asia/Seoul' }));
const { DesktopRemoteDevices } = await import('./desktop-remote-devices');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const phone = (over: Record<string, unknown> = {}) => ({
  id: 'p1', label: 'iPhone', confirm_number: '482 917', last_used_at: null,
  pairs: [{ setup_id: 's1', device_name: 'SYJ-MacBook-Pro', paired_at: '2026-10-02T03:00:00Z' }], ...over,
});
// the two reads on mount, by address
function answers(devices: unknown[], enabled: boolean | null = true) {
  fetchWithAuth.mockImplementation(async (url: string) => (
    url === '/api/remote-devices' ? json({ devices })
      : enabled === null ? json({}, 403) : json({ data: { enabled, enabled_at: null, can_change: false } })
  ));
}

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
        <DesktopRemoteDevices />
      </NextIntlClientProvider>,
    );
  });
  await flush();
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => container.textContent ?? '';
const button = (label: string) => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === label);
const status = () => container.querySelector('[role="status"]')?.textContent;

describe('DesktopRemoteDevices (story #4533)', () => {
  it('lists one line per pair with the confirmation number, and no pairing button', async () => {
    answers([phone({ pairs: [...phone().pairs, { setup_id: 's2', device_name: 'Mac-mini', paired_at: '2026-09-30T03:00:00Z' }] })]);
    await render();
    const rows = container.querySelectorAll('[data-testid="desktop-remote-device-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('짝: SYJ-MacBook-Pro');
    expect(rows[0].textContent).toContain('10월 2일');
    expect(rows[1].textContent).toContain('짝: Mac-mini');
    expect(text()).toContain('폰 확인 숫자 482 917'); // v1.11: the fixed number has its own name (유나 21:00Z)
    expect(container.querySelector('[title="폰 앱 설정 › 이 폰의 폰 확인 숫자와 같으면 그 폰이 맞아요"]')).not.toBeNull();
    expect(button('빼기')).toHaveLength(2);
    expect(text()).not.toContain('짝짓기]로'); // the empty line only when empty
    expect(text()).not.toContain('원격 제어가 꺼져 있어요');
  });

  it('[빼기] asks in line with [취소] focused, then removes that pair and says so (the name in the label place)', async () => {
    answers([phone({ label: '내 아이폰' })]);
    await render();
    await act(async () => { button('빼기')[0].click(); });
    expect(text()).toContain('내 아이폰 ↔ SYJ-MacBook-Pro 짝을 뺄까요? 빼면 그 폰에서 이 컴퓨터를 제어할 수 없어요');
    expect(document.activeElement?.textContent).toBe('취소');

    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ removed: true }) : url === '/api/remote-devices' ? json({ devices: [phone({ pairs: [] })] }) : json({ data: { enabled: true } })
    ));
    await act(async () => { button('빼기')[1].click(); });
    await flush();
    const del = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
    expect(del?.[0]).toBe('/api/remote-devices/p1/pairs/s1');
    expect(status()).toBe('뺐어요 · 내 아이폰');
    expect(document.activeElement).toBe(container.querySelector('[role="status"]')); // the row is gone: the result line
    expect(text()).toContain('아직 짝지은 폰이 없어요');
  });

  it('a pair already gone says so, [취소] closes without asking the server', async () => {
    answers([phone({ label: '갤럭시' })]);
    await render();
    await act(async () => { button('빼기')[0].click(); });
    await act(async () => { button('취소')[0].click(); });
    expect(text()).not.toContain('짝을 뺄까요');
    expect(document.activeElement).toBe(button('빼기')[0]); // back to that row's [빼기], not the page
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    await act(async () => { button('빼기')[0].click(); });
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ removed: false }) : url === '/api/remote-devices' ? json({ devices: [] }) : json({ data: { enabled: true } })
    ));
    await act(async () => { button('빼기')[1].click(); });
    await flush();
    expect(status()).toBe('이미 빠져 있었어요 · 갤럭시');
  });

  it('empty, and the org with remote control off', async () => {
    answers([], false);
    await render();
    expect(text()).toContain('아직 짝지은 폰이 없어요');
    expect(text()).not.toContain('폰 짝짓기'); // the tail comes back with 4531's button, and only with the org on (PO · Yuna 19:00Z)
    expect(text()).toContain('지금 조직(문클랩스)은 원격 제어가 꺼져 있어요 — 짝지은 기기로 상태는 보이지만 제어는 안 돼요');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('a failed list read draws nothing', async () => {
    fetchWithAuth.mockResolvedValue(json({}, 500));
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('reads in English', async () => {
    answers([phone()]);
    await render('en');
    expect(text()).toContain('Paired with SYJ-MacBook-Pro');
    await act(async () => { button('Remove')[0].click(); });
    expect(text()).toContain('Remove the pairing iPhone ↔ SYJ-MacBook-Pro? That phone will no longer be able to control this computer');
  });
});
