// @vitest-environment jsdom
//
// story #4532 (명세 b0713c54 «페어링 화면 · 페어링 숫자 · 폰 확인 숫자» 폰 표) — the pairing screen inside the phone app: start →
// confirm (no number yet) → checking → the pairing number (big) → paired · each refusal's line and button · nothing outside the app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { __resetPhoneBridgeForTest, claimPhoneBridge } from '@/lib/phone-bridge';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const { PhonePairing } = await import('./phone-pairing');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEAD = {
  offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef',
  device_name: 'SYJ-MacBook-Pro', expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const KEY_ID = '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd';
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

let sent: Array<{ type: string; args: Record<string, unknown> }> = [];
let shell: Record<string, Record<string, unknown>>;
function installShell() {
  window.__sprintablePhone = {
    claim(onReply) {
      delete window.__sprintablePhone;
      return (m) => {
        sent.push({ type: m.type, args: m.args });
        queueMicrotask(() => onReply({ id: m.id, ...(shell[m.type] ?? { ok: false, code: 'bad_request' }) } as never));
      };
    },
  };
  claimPhoneBridge();
}
let offerState: { state: string; reveal: string | null };
let pairs: Array<{ setup_id: string }>;
let offerPost: () => Response;
let registerPost: () => Response;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sent = [];
  shell = {
    'pair.scan': { ok: true, ...HEAD },
    'device.key.info': { ok: true, public_key: 'SPKI', key_number: '482 917' },
    'pair.mac': { ok: true, mac: 'MAC' },
    'pair.number': { ok: true, number: '296 843' },
    'app.settings': { ok: true },
  };
  offerState = { state: 'sent', reveal: null };
  pairs = [];
  offerPost = () => res(202, { state: 'sent' });
  registerPost = () => res(201, { id: KEY_ID });
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    if (key === 'POST /api/remote-devices') return registerPost();
    if (key === 'GET /api/remote-devices') return res(200, { devices: [{ id: KEY_ID, pairs }] });
    if (key === 'POST /api/remote-devices/pairing-offers') return offerPost();
    if (key === `GET /api/remote-devices/pairing-offers/${HEAD.offer_id}`) return res(200, offerState);
    throw new Error(`unexpected ${key}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  __resetPhoneBridgeForTest();
  delete window.__sprintablePhone;
});

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
async function render(locale: 'ko' | 'en' = 'ko', returnTo?: string | null) {
  await act(async () => {
    root.render(
      <PhoneBridgeClaim><NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <PhonePairing returnTo={returnTo} />
      </NextIntlClientProvider></PhoneBridgeClaim>,
    );
  });
  await settle();
}
const text = () => container.textContent ?? '';
const line = () => container.querySelector('[data-testid="phone-pairing-line"]')?.textContent;
const buttons = () => [...container.querySelectorAll('button, a')].map((b) => b.textContent);
const press = async (label: string) => {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}: ${buttons().join(',')}`);
  await act(async () => { b.click(); });
  await settle();
};
const tick = async () => { await act(async () => { vi.advanceTimersByTime(1_500); }); await settle(); };

describe('[4532] phone pairing screen', () => {
  it('the handle comes after the first render → the screen flips to the phone path without a reload (story #4661)', async () => {
    await render();
    expect(buttons()).not.toContain('QR 찍기');
    await act(async () => { installShell(); });
    await settle();
    expect(buttons()).toContain('QR 찍기');
  });

  it('outside the phone app: one line, no button', async () => {
    await render();
    expect(text()).toBe('폰의 Sprintable 앱에서 이 화면을 열어 주세요');
    expect(buttons()).toEqual([]);
  });

  it('start → scan → «이 컴퓨터와 페어링할까요?» (no number) → [페어링] → checking → the number → paired', async () => {
    installShell();
    await render();
    expect(text()).toContain('컴퓨터와 페어링 — 컴퓨터의 Sprintable 앱에서 [폰 페어링]을 눌러 나온 QR을 찍어 주세요');
    await press('QR 찍기');
    expect(line()).toBe('이 컴퓨터와 페어링할까요? · SYJ-MacBook-Pro');
    expect(text()).not.toMatch(/\d{3} \d{3}/); // no number before the computer takes the offer
    expect(buttons()).toEqual(['페어링', '취소']);
    await press('페어링');
    expect(sent.map((s) => s.type)).toEqual(['pair.scan', 'device.key.info', 'pair.mac']);
    expect(line()).toBe('컴퓨터 화면을 확인하는 중…');
    await tick();
    expect(line()).toBe('컴퓨터 화면을 확인하는 중…'); // still «sent»
    offerState = { state: 'revealed', reveal: 'R' };
    await tick();
    // Yuna 07:48Z ②: three lines in the one status — the lead · the number alone · what to do (no «·» / «—» joins)
    const lineEl = container.querySelector('[data-testid="phone-pairing-line"]')!;
    const parts = ['pairing-number-lead', 'pairing-number', 'pairing-number-hint'].map((id) => lineEl.querySelector(`[data-testid="${id}"]`));
    expect(parts.map((p) => p?.textContent)).toEqual(['페어링 숫자', '296 843', '컴퓨터 화면에서 이 숫자를 골라 주세요']);
    expect(parts.every((p) => p?.classList.contains('block'))).toBe(true);
    expect(line()).toBe('페어링 숫자296 843컴퓨터 화면에서 이 숫자를 골라 주세요'); // nothing else in that status
    // Yuna 07:48Z ①: a Korean line breaks between words, never inside one («주세 / 요»)
    expect(lineEl.className).toMatch(/\bbreak-keep\b/);
    expect(sent.filter((s) => s.type === 'pair.number')).toEqual([{ type: 'pair.number', args: { offer_id: HEAD.offer_id, reveal: 'R' } }]);
    await tick();
    expect(sent.filter((s) => s.type === 'pair.number')).toHaveLength(1); // asked once
    pairs = [{ setup_id: HEAD.setup_id }];
    await tick();
    expect(line()).toBe('페어링했어요 · SYJ-MacBook-Pro — 이제 이 폰에서 그 컴퓨터의 에이전트에 답하고, 멈추거나 지시할 수 있어요');
    expect(buttons()).toEqual(['닫기']);
    const looks = fetchWithAuth.mock.calls.length;
    await tick();
    await tick();
    expect(fetchWithAuth.mock.calls.length).toBe(looks); // no more looks after paired
  });

  it('the computer said «different» or the QR ran out while waiting → «페어링하지 못했어요» + [다시 찍기]', async () => {
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    offerState = { state: 'expired', reveal: null };
    await tick();
    expect(line()).toBe('페어링하지 못했어요 — 컴퓨터에서 새 QR을 만들어 다시 찍어 주세요');
    expect(buttons()).toEqual(['다시 찍기']);
  });

  it('[취소] while waiting stops looking and goes back to the start', async () => {
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    await press('취소');
    expect(text()).toContain('[폰 페어링]');
    const before = fetchWithAuth.mock.calls.length;
    await tick();
    await tick();
    expect(fetchWithAuth.mock.calls.length).toBe(before);
  });

  it.each([
    [{ ok: false, code: 'not_ours' }, 'Sprintable 페어링 QR이 아니에요'],
    [{ ok: false, code: 'expired' }, '이 QR은 시간이 지났어요 — 컴퓨터에서 새 QR을 만들어 주세요'],
  ])('the scan says %j → its line + [다시 찍기]', async (answer, expected) => {
    shell['pair.scan'] = answer;
    installShell();
    await render();
    await press('QR 찍기');
    expect(line()).toBe(expected);
    expect(buttons()).toEqual(['다시 찍기']);
  });

  it('closing the camera goes back to the start', async () => {
    shell['pair.scan'] = { ok: false, code: 'cancelled' };
    installShell();
    await render();
    await press('QR 찍기');
    expect(buttons()).toEqual(['QR 찍기']);
  });

  it.each([
    [409, 'offer_used', '이 QR은 이미 쓰였어요 — 컴퓨터에서 새 QR을 만들어 다시 찍어 주세요', ['다시 찍기']],
    [409, 'device_unreachable', '그 컴퓨터에 지금 닿지 않아요 — 컴퓨터의 Sprintable 앱이 켜져 있는지 본 뒤 다시 찍어 주세요', ['다시 찍기']],
    [404, 'setup_not_found', '이 QR의 컴퓨터를 찾지 못했어요 — 같은 조직의 컴퓨터인지 확인해 주세요', ['다시 찍기']],
    [404, 'phone_key_not_found', '이 폰을 다시 등록해야 해요 — [다시 찍기]를 누르면 등록부터 해요', ['다시 찍기']],
    [422, 'invalid_expiry', '이 QR은 시간이 지났어요 — 컴퓨터에서 새 QR을 만들어 주세요', ['다시 찍기']],
    [409, 'remote_control_off', '원격 제어가 꺼져 있어 페어링할 수 없어요 — 조직 소유자가 켜면 다시 할 수 있어요', ['닫기']], // story #4583 (no org read here: no names)
  ])('the offer refused %i %s → its line', async (status, code, expected, left) => {
    offerPost = () => res(status, { error: { code } });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe(expected);
    expect(buttons()).toEqual(left);
  });

  it('already paired with that computer → «이미 페어링된 컴퓨터예요» + [닫기], nothing offered', async () => {
    pairs = [{ setup_id: HEAD.setup_id }];
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe('이미 페어링된 컴퓨터예요');
    expect(buttons()).toEqual(['닫기']);
    expect(sent.some((s) => s.type === 'pair.mac')).toBe(false);
  });

  // story 4780 — [닫기] goes back to the page the pairing was started from (the page hands it over as `returnTo`); none → the Mac screen as before
  describe('[4780] [닫기] goes back where the pairing started', () => {
    const closeHref = () => [...container.querySelectorAll('a')].find((x) => x.textContent === '닫기')?.getAttribute('href');

    it('already paired: [닫기] → the page it came from (Today) · none given → /desktop', async () => {
      pairs = [{ setup_id: HEAD.setup_id }];
      installShell();
      await render('ko', '/today?p=proj-1');
      await press('QR 찍기');
      await press('페어링');
      expect(line()).toBe('이미 페어링된 컴퓨터예요');
      expect(closeHref()).toBe('/today?p=proj-1'); // reverted (the fixed /desktop) → '/desktop'
    });

    it('already paired, no way back handed over → /desktop (as it always was)', async () => {
      pairs = [{ setup_id: HEAD.setup_id }];
      installShell();
      await render('ko', null);
      await press('QR 찍기');
      await press('페어링');
      expect(closeHref()).toBe('/desktop');
    });

    it('paired after the number → [닫기] goes back too (a conversation here)', async () => {
      installShell();
      await render('ko', '/chats/conv-7');
      await press('QR 찍기');
      await press('페어링');
      await tick();
      offerState = { state: 'revealed', reveal: 'R' };
      await tick();
      expect(line()).toContain('296 843'); // the number first
      pairs = [{ setup_id: HEAD.setup_id }];
      await tick();
      expect(line()).toContain('페어링했어요');
      expect(closeHref()).toBe('/chats/conv-7');
    });
  });

  it('an empty last-use value reads the relative time, never «아직 안 씀» (story #4624 · Yuna)', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_limit' } });
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/remote-devices' && (init?.method ?? 'GET') === 'GET') {
        return res(200, { devices: [{ id: 'p-9', label: '빈 값 폰', last_used_at: '', pairs: [] }] });
      }
      return base(url, init);
    });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    const row = container.querySelector('[data-testid="pairing-limit-phone"]');
    expect(row?.textContent).not.toContain('아직 안 씀');
  });

  it('a removal that fails shows no «자리가 하나 비었어요» line (story #4624 · 까디르)', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_limit' } });
    const phones = [{ id: 'p-1', label: '내 폰 A', last_used_at: null, pairs: [] }];
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/remote-devices' && (init?.method ?? 'GET') === 'GET') return res(200, { devices: phones });
      if (url === '/api/remote-devices/p-1' && init?.method === 'DELETE') return res(500, { error: { code: 'internal' } });
      return base(url, init);
    });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    await press('이 폰 빼기');
    await press('이 폰 빼기');
    expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/api/remote-devices/p-1' && init?.method === 'DELETE')).toBe(true);
    expect(document.body.textContent).not.toContain('자리가 하나 비었어요');
    expect(document.body.textContent).not.toContain('뺐어요');
  });

  it('three phones → one [이 폰 빼기] → confirm → the place is free → [다시 찍기] starts the scan again (story #4624 · 까디르)', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_limit' } });
    const phones = [
      { id: 'p-1', label: '폰 하나', last_used_at: '2026-10-01T00:00:00Z', pairs: [] },
      { id: 'p-2', label: '폰 둘', last_used_at: null, pairs: [] },
      { id: 'p-3', label: '폰 셋', last_used_at: '2026-10-02T00:00:00Z', pairs: [] },
    ];
    let removed = false;
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/remote-devices' && (init?.method ?? 'GET') === 'GET') return res(200, { devices: removed ? phones.filter((p) => p.id !== 'p-2') : phones });
      if (url === '/api/remote-devices/p-2' && init?.method === 'DELETE') { removed = true; return res(200, { removed: true }); }
      return base(url, init);
    });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(container.querySelectorAll('[data-testid="pairing-limit-phone"]').length).toBe(3);
    const row = [...container.querySelectorAll('[data-testid="pairing-limit-phone"]')][1] as HTMLElement;
    await act(async () => { [...row.querySelectorAll('button')].find((b) => b.textContent === '이 폰 빼기')!.click(); });
    await settle();
    const askedRow = [...container.querySelectorAll('[data-testid="pairing-limit-phone"]')][1] as HTMLElement;
    await act(async () => { [...askedRow.querySelectorAll('button')].find((b) => b.textContent === '이 폰 빼기')!.click(); });
    await settle();
    expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/api/remote-devices/p-2' && init?.method === 'DELETE')).toBe(true);
    expect(document.body.textContent).toContain('자리가 하나 비었어요');
    const left = [...container.querySelectorAll('[data-testid="pairing-limit-phone"]')].map((r) => r.textContent ?? '');
    expect(left.length).toBe(2);
    expect(left.some((t) => t.includes('폰 둘'))).toBe(false);
    expect(left.some((t) => t.includes('폰 하나'))).toBe(true);
    expect(left.some((t) => t.includes('폰 셋'))).toBe(true);
    sent.length = 0;
    await press('다시 찍기');
    expect(sent.some((m) => m.type === 'pair.scan')).toBe(true);
  });

  it('three phones already → the limit screen lists this account\'s phones; one confirm removes one, then the rescan (story #4624)', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_limit' } });
    const phones = [
      { id: 'p-1', label: '내 폰 A', last_used_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), pairs: [{ device_name: 'SYJ-MacBook-Pro' }] },
      { id: 'p-2', label: '내 폰 B', last_used_at: null, pairs: [] },
    ];
    const base = fetchWithAuth.getMockImplementation()!;
    let removed = false;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/remote-devices' && (init?.method ?? 'GET') === 'GET') {
        return res(200, { devices: removed ? [phones[1]] : phones });
      }
      if (url === '/api/remote-devices/p-1' && init?.method === 'DELETE') {
        removed = true;
        return res(200, { removed: true });
      }
      return base(url, init);
    });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe('원격 기기가 셋 다 찼어요');
    expect(document.body.textContent).toContain('내 폰 A');
    expect(document.body.textContent).toContain('내 폰 B');
    expect(buttons()).toContain('웹에서 빼 주세요');
    expect(document.body.textContent).toContain('이름 · 마지막 쓴 때');
    expect(document.body.textContent).toContain('아직 안 씀');
    // story #4624 (유나 조건): 「아직 안 씀」 only where last_used_at is null — a phone with a last use reads its relative time
    const rows = container.querySelectorAll('[data-testid="pairing-limit-phone"]');
    expect(rows[0].textContent).not.toContain('아직 안 씀');
    expect(rows[0].textContent).toContain('그저께');
    expect(rows[1].textContent).toContain('아직 안 씀');
    expect(document.body.textContent).not.toContain('자리가 하나 비었어요');
    await press('이 폰 빼기');
    expect(document.body.textContent).toContain('이 폰을 뺄까요?');
    await press('이 폰 빼기');
    expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/api/remote-devices/p-1' && init?.method === 'DELETE')).toBe(true);
    expect(document.body.textContent).toContain('뺐어요 · 내 폰 A');
    expect(container.querySelectorAll('[data-testid="pairing-limit-phone"]').length).toBe(1);
    expect(document.body.textContent).toContain('자리가 하나 비었어요. [다시 찍기]를 누르면 새 QR로 이어서 페어링해요');
    expect(buttons()).toContain('다시 찍기');
  });

  it('this phone registered to another account → its own line (never who) + [다시 찍기] (story #4624)', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_taken' } });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe('이 폰은 다른 Sprintable 계정에 등록돼 있어 페어링할 수 없어요 — 그 계정으로 로그인해 페어링하거나, 그 계정의 웹 «데스크톱 앱 › 원격 기기»에서 이 폰을 뺀 뒤 다시 찍어 주세요');
    expect(buttons()).toEqual(['다시 찍기']);
  });

  it('the same person\'s phone paired in another organization → its own line (the way out: remove it THERE) + [다시 찍기] (story 4695 · Yuna takenOtherOrg)', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_other_org' } });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe('이 폰은 다른 조직의 컴퓨터와 이미 페어링돼 있어 여기서는 페어링할 수 없어요 — 그 조직의 웹 «데스크톱 앱 › 원격 기기»에서 이 폰을 뺀 뒤 다시 찍어 주세요');
    expect(buttons()).toEqual(['다시 찍기']);
  });

  it('…and it names the organization when the server does (Yuna {org} line) — where to remove the phone', async () => {
    registerPost = () => res(409, { error: { code: 'remote_device_other_org', detail: { org_name: 'Moonklabs' } } });
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe('이 폰은 Moonklabs 조직의 컴퓨터와 이미 페어링돼 있어 여기서는 페어링할 수 없어요 — 그 조직의 웹 «데스크톱 앱 › 원격 기기»에서 이 폰을 뺀 뒤 다시 찍어 주세요');
    expect(buttons()).toEqual(['다시 찍기']);
  });

  it('a phone with no screen lock → the line + [설정 열기] (the shell opens the settings) + [다시 찍기]', async () => {
    shell['device.key.info'] = { ok: false, code: 'no_screen_lock' };
    installShell();
    await render();
    await press('QR 찍기');
    await press('페어링');
    expect(line()).toBe('화면 잠금이 없는 폰에서는 답할 수 없어요 — 폰 설정에서 화면 잠금을 켜 주세요');
    expect(buttons()).toEqual(['설정 열기', '다시 찍기']);
    await press('설정 열기');
    expect(sent.at(-1)).toEqual({ type: 'app.settings', args: {} });
  });

  it('reads in English', async () => {
    installShell();
    await render('en');
    await press('Scan QR');
    expect(line()).toBe('Pair with this computer? · SYJ-MacBook-Pro');
    await press('Pair');
    offerState = { state: 'revealed', reveal: 'R' };
    await tick();
    expect(['pairing-number-lead', 'pairing-number', 'pairing-number-hint'].map((id) => container.querySelector(`[data-testid="${id}"]`)?.textContent))
      .toEqual(['Pairing number', '296 843', 'Pick this number on the computer']); // Yuna 07:48Z ②
  });
});
