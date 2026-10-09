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
    expect(rows[0].textContent).toContain('페어링: SYJ-MacBook-Pro');
    expect(rows[0].textContent).toContain('10월 2일');
    expect(rows[1].textContent).toContain('페어링: Mac-mini');
    expect(text()).toContain('폰 확인 숫자 482 917'); // v1.11: the fixed number has its own name (유나 21:00Z)
    expect(container.querySelector('[title="폰 앱 설정 › 이 폰의 폰 확인 숫자와 같으면 그 폰이 맞아요"]')).not.toBeNull();
    expect(button('빼기')).toHaveLength(2);
    expect(button('이 폰 빼기')).toHaveLength(1); // story #4624: one per phone, on its head line
    expect(text()).not.toContain('페어링]로'); // the empty line only when empty
    expect(text()).not.toContain('원격 제어가 꺼져 있어요');
  });

  it('[빼기] asks in line with [취소] focused, then removes that pair and says so (the name in the label place)', async () => {
    answers([phone({ label: '내 아이폰' })]);
    await render();
    await act(async () => { button('빼기')[0].click(); });
    expect(text()).toContain('내 아이폰 ↔ SYJ-MacBook-Pro 페어링을 해제할까요? 해제하면 그 폰에서 이 컴퓨터를 제어할 수 없어요 — 원격 기기 자리는 그대로예요');
    expect(document.activeElement?.textContent).toBe('취소');

    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ removed: true }) : url === '/api/remote-devices' ? json({ devices: [phone({ pairs: [] })] }) : json({ data: { enabled: true } })
    ));
    await act(async () => { button('해제')[0].click(); });
    await flush();
    const del = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
    expect(del?.[0]).toBe('/api/remote-devices/p1/pairs/s1');
    expect(status()).toBe('뺐어요 · 내 아이폰');
    expect(document.activeElement).toBe(container.querySelector('[role="status"]')); // the row is gone: the result line
    // story #4624: the phone stays listed with no pair (its key still holds a place) — only [이 폰 빼기] frees it
    expect(text()).toContain('페어링 없음');
    expect(text()).not.toContain('아직 페어링된 폰이 없어요');
    expect(button('이 폰 빼기')).toHaveLength(1);
  });

  it('a pair already gone says so, [취소] closes without asking the server', async () => {
    answers([phone({ label: '갤럭시' })]);
    await render();
    await act(async () => { button('빼기')[0].click(); });
    await act(async () => { button('취소')[0].click(); });
    expect(text()).not.toContain('페어링을 해제할까요');
    expect(document.activeElement).toBe(button('빼기')[0]); // back to that row's [빼기], not the page
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    await act(async () => { button('빼기')[0].click(); });
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ removed: false }) : url === '/api/remote-devices' ? json({ devices: [] }) : json({ data: { enabled: true } })
    ));
    await act(async () => { button('해제')[0].click(); });
    await flush();
    expect(status()).toBe('이미 빠져 있었어요 · 갤럭시');
  });

  it('empty, and the org with remote control off', async () => {
    answers([], false);
    await render();
    expect(text()).toContain('아직 페어링된 폰이 없어요');
    expect(text()).not.toContain('폰 페어링'); // the tail comes back with 4531's button, and only with the org on (PO · Yuna 19:00Z)
    expect(text()).toContain('지금 조직(문클랩스)은 원격 제어가 꺼져 있어요 — 페어링된 기기로 상태는 보이지만 제어는 안 돼요');
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
    expect(text()).toContain('Remove the iPhone ↔ SYJ-MacBook-Pro pair? That phone can no longer control this computer — its remote device place stays taken');
    expect(button('Remove this phone')).toHaveLength(1);
  });

  // story #4624 (1선 · Yuna «미르코 범위»)
  it('[이 폰 빼기] asks in line ([취소] first) with the pair count, removes the key itself, and says the place is free', async () => {
    answers([phone({ label: 'Galaxy S24', pairs: [...phone().pairs, { setup_id: 's2', device_name: 'Studio', paired_at: '2026-09-30T03:00:00Z' }] })]);
    await render();
    await act(async () => { button('이 폰 빼기')[0].click(); });
    expect(text()).toContain('이 폰을 뺄까요? · Galaxy S24 — 빼면 그 폰으로는 승인 · 멈춤 · 지시를 할 수 없고, 페어링된 컴퓨터 2대와 모두 끊겨요. 원격 기기 자리 하나가 비고, 그 폰을 다시 쓰려면 폰에서 페어링을 새로 해요.');
    expect(document.activeElement?.textContent).toBe('취소');
    expect(button('빼기').every((b) => b.disabled || b.closest('[role="group"]'))).toBe(true); // the pair buttons wait while it asks
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ removed: true }) : url === '/api/remote-devices' ? json({ devices: [] }) : json({ data: { enabled: true } })
    ));
    const confirm = container.querySelector('[role="group"] button') as HTMLButtonElement;
    expect(confirm.textContent).toBe('빼기');
    await act(async () => { confirm.click(); });
    await flush();
    const dels = fetchWithAuth.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE').map(([u]) => u);
    expect(dels).toEqual(['/api/remote-devices/p1']); // the key itself — not its pairs one by one
    expect(status()).toBe('뺐어요 · Galaxy S24 — 원격 기기 자리 하나가 비었어요');
    expect(document.activeElement).toBe(container.querySelector('[role="status"]'));
    expect(text()).toContain('아직 페어링된 폰이 없어요');
  });

  // story #4629 (Yuna «4629»): removing a phone also says whether its login was ended — ended (muted, as the line was) · not_found
  // (the text colour: it must be read; not a warning — nothing to do next) · a server that does not say → the line as before
  it('[4629] the result says whether that phone\'s login was ended: ended · not_found · (older server) the line as before', async () => {
    const result = () => container.querySelector('[data-testid="desktop-remote-devices-result"]') as HTMLElement;
    const removeWith = async (answer: Record<string, unknown>, locale: 'ko' | 'en' = 'ko') => {
      await act(async () => { root.unmount(); }); // a fresh mount each time: the list is read anew
      root = createRoot(container);
      answers([phone({ label: 'Galaxy S24' })]);
      await render(locale);
      await act(async () => { button(locale === 'ko' ? '이 폰 빼기' : 'Remove this phone')[0].click(); });
      fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
        init?.method === 'DELETE' ? json(answer) : url === '/api/remote-devices' ? json({ devices: [] }) : json({ data: { enabled: true } })
      ));
      await act(async () => { (container.querySelector('[role="group"] button') as HTMLButtonElement).click(); });
      await flush();
    };
    await removeWith({ removed: true, session: 'ended' });
    expect(result().querySelector('a')).toBeNull(); // only the not_found line carries the link
    expect(status()).toBe('뺐어요 · Galaxy S24 — 원격 기기 자리 하나가 비었어요. 그 폰은 이제 승인 · 멈춤 · 지시를 못 하고, 길어야 1시간 안에 로그아웃돼요');
    expect(result().className).toContain('text-muted-foreground');
    await removeWith({ removed: true, session: 'not_found' });
    expect(status()).toBe('뺐어요 · Galaxy S24 — 원격 기기 자리 하나가 비었어요. 그 폰의 로그인은 찾지 못했어요(이미 로그아웃됐을 수 있어요) — 그 폰으로 승인 · 멈춤 · 지시는 더는 못 하고, 로그인이 남았을까 걱정되면 다른 기기에서 모두 로그아웃');
    // story #4630 AC3 (Yuna «4630» ③): the tail is a link to «로그인한 다른 기기» (settings › account) — it runs nothing here
    const tail = result().querySelector('a[data-testid="desktop-remote-devices-sign-out-elsewhere"]') as HTMLAnchorElement;
    expect(tail.textContent).toBe('다른 기기에서 모두 로그아웃');
    const to = new URL(tail.getAttribute('href')!, 'http://x');
    expect(to.pathname + '?tab=' + to.searchParams.get('tab')).toBe('/settings?tab=profile'); // settings › account (the card under 2FA)
    expect(result().className).toContain('text-foreground');
    expect(result().className).not.toContain('text-muted-foreground');
    expect(result().className).not.toMatch(/warning|destructive|amber|red/);
    await removeWith({ removed: true });
    expect(status()).toBe('뺐어요 · Galaxy S24 — 원격 기기 자리 하나가 비었어요');
    expect(result().className).toContain('text-muted-foreground');
    await removeWith({ removed: true, session: 'not_found' }, 'en');
    expect(status()).toBe("Removed · Galaxy S24 — one remote device place is free. Its sign-in wasn't found (it may already be signed out) — it can no longer approve, stop or instruct; if you're worried a sign-in is left, Sign out everywhere else");
    expect(result().querySelector('a')?.textContent).toBe('Sign out everywhere else');
    await removeWith({ removed: true, session: 'ended' }, 'en');
    expect(status()).toBe('Removed · Galaxy S24 — one remote device place is free. That phone can no longer approve, stop or instruct, and it will be signed out within an hour');
  });

  it('a phone with no pair left is still listed («페어링 없음» + [이 폰 빼기]) · phones sorted by the longest unused first · [취소] returns to the button', async () => {
    answers([
      phone({ id: 'new', label: 'Pixel', last_used_at: '2026-10-08T07:00:00Z' }),
      phone({ id: 'dead', label: 'Galaxy (지운 앱)', last_used_at: null, pairs: [] }),
      phone({ id: 'mid', label: 'iPad', last_used_at: '2026-10-01T07:00:00Z', pairs: [] }),
    ]);
    await render();
    const heads = Array.from(container.querySelectorAll('[data-testid="desktop-remote-phone"]')).map((li) => li.querySelector('span')?.textContent);
    expect(heads).toEqual(['Galaxy (지운 앱)', 'iPad', 'Pixel']); // never used first, then the oldest use
    expect(button('이 폰 빼기')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="desktop-remote-phone"]')[0].textContent).toContain('페어링 없음');
    await act(async () => { button('이 폰 빼기')[0].click(); });
    // Yuna 08:14Z: no pair → its own line, without a cost it does not have
    expect(text()).toContain('이 폰을 뺄까요? · Galaxy (지운 앱) — 페어링된 컴퓨터는 없어요. 빼면 원격 기기 자리 하나가 비고, 그 폰을 다시 쓰려면 폰에서 페어링을 새로 해요.');
    expect(text()).not.toContain('0대');
    await act(async () => { button('취소')[0].click(); });
    expect(document.activeElement).toBe(button('이 폰 빼기')[0]);
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('a key already removed says so', async () => {
    answers([phone({ label: 'Galaxy' })]);
    await render();
    await act(async () => { button('이 폰 빼기')[0].click(); });
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ removed: false }) : url === '/api/remote-devices' ? json({ devices: [] }) : json({ data: { enabled: true } })
    ));
    await act(async () => { (container.querySelector('[role="group"] button') as HTMLButtonElement).click(); });
    await flush();
    expect(status()).toBe('이미 빠져 있었어요 · Galaxy');
  });

  it('a failed removal says so, and the phone stays', async () => {
    answers([phone({ label: 'Galaxy' })]);
    await render();
    await act(async () => { button('이 폰 빼기')[0].click(); });
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({}, 500) : url === '/api/remote-devices' ? json({ devices: [phone()] }) : json({ data: { enabled: true } })
    ));
    await act(async () => { (container.querySelector('[role="group"] button') as HTMLButtonElement).click(); });
    await flush();
    expect(status()).toBe('빼지 못했어요 — 다시 시도해 주세요');
  });

  it('[Remove this phone] reads in English with the computer count', async () => {
    answers([phone()]);
    await render('en');
    await act(async () => { button('Remove this phone')[0].click(); });
    expect(text()).toContain('Remove this phone? · iPhone — it can no longer approve, stop or instruct, and it is disconnected from all 1 paired computer. One remote device place is freed; to use it again, pair it again from the phone.');
  });

  it('a phone with no pair reads «No paired computers» and its own confirmation in English', async () => {
    answers([phone({ pairs: [] })]);
    await render('en');
    expect(text()).toContain('No paired computers');
    await act(async () => { button('Remove this phone')[0].click(); });
    expect(text()).toContain("Remove this phone? · iPhone — it isn't paired with any computer. One remote device place is freed; to use it again, pair it again from the phone.");
  });
});
