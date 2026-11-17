// @vitest-environment jsdom
//
// story 4972 — the pairing screen on a NEW-procedure QR (v2): [페어링] → the commitment → «컴퓨터 화면을 확인하는 중…» → the computer's nonce → (one OS prompt: the shell) → the reveal → the number in the SHELL's own window (this page draws none) → the computer's own [같아요] → paired.
// The procedure is the scanned QR's version and nothing else: an old QR still pairs the old way, not one call of the new one.
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
  device_name: 'My Mac', expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), version: 2,
};
const KEY_ID = '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd';
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

let sent: Array<{ type: string; args: Record<string, unknown> }> = [];
let shell: Record<string, Record<string, unknown>>;
const slow = new Set<string>(); // types whose answer is held until the test releases it (a real OS prompt takes seconds)
const release: Record<string, () => void> = {};
function installShell() {
  window.__sprintablePhone = {
    claim(onReply) {
      delete window.__sprintablePhone;
      return (m) => {
        sent.push({ type: m.type, args: m.args });
        const answer = () => onReply({ id: m.id, ...(shell[m.type] ?? { ok: false, code: 'bad_request' }) } as never);
        if (slow.has(m.type)) release[m.type] = answer; else queueMicrotask(answer);
      };
    },
  };
  claimPhoneBridge();
}
let pairs: Array<{ setup_id: string }>;
let registerPost: () => Response;

let container: HTMLDivElement;
let root: Root;

let sessionState: { state: string; n_m: string | null; sig: string | null };
let serverCalls: string[];
let commitPost: () => Response;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sent = [];
  slow.clear();
  serverCalls = [];
  shell = {
    'pair.scan': { ok: true, ...HEAD },
    'device.key.info': { ok: true, public_key: 'SPKI', key_number: '482 917' },
    'pair.commit': { ok: true, commit: 'C'.repeat(43) },
    'pair.reveal': { ok: true, reveal: { phone_spki: 'S', phone_box_pub: 'B', n_p: 'P', label: 'iPhone', binding_sig: 'G' } },
    'pair.compare': { ok: true, pinned: true },
    'app.settings': { ok: true },
  };
  sessionState = { state: 'committed', n_m: null, sig: null };
  pairs = [];
  commitPost = () => res(202, { state: 'committed' });
  registerPost = () => res(201, { id: KEY_ID });
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    serverCalls.push(key);
    if (key === 'POST /api/remote-devices') return registerPost();
    if (key === 'GET /api/remote-devices') return res(200, { devices: [{ id: KEY_ID, pairs }] });
    if (key === `POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/commit`) return commitPost();
    if (key === `GET /api/remote-devices/pairing-sessions/${HEAD.offer_id}`) return res(200, sessionState);
    if (key === `POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/reveal`) return res(202, { state: 'revealed' });
    if (key === `POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`) return res(200, { state: 'burned' });
    if (key === 'GET /api/remote-devices/pairing-target') return res(404, {});
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


const START = async () => { await render(); await press('QR 찍기'); await press('페어링'); };
const sentTypes = () => sent.map((s) => s.type);

const NONCE = { state: 'nonce', n_m: 'N'.repeat(22), sig: 'S'.repeat(70) };
const REVEAL_OK = { ok: true, reveal: { phone_spki: 'S', phone_box_pub: 'B', n_p: 'P', label: 'iPhone', binding_sig: 'G' } };

describe('[4972] the new pairing on the phone screen', () => {
  it('commit → «확인하는 중» → the computer\'s nonce → ONE reveal → the shell\'s own window for the number (the page draws none) → pinned → «컴퓨터에서 확인하는 중» → paired', async () => {
    installShell();
    await START();
    expect(sentTypes().filter((t) => t === 'pair.commit')).toHaveLength(1);
    expect(sentTypes()).not.toContain('pair.mac'); // the old procedure is not touched
    expect(line()).toBe('컴퓨터 화면을 확인하는 중…');
    await tick(); // still committed: waiting
    expect(sentTypes()).not.toContain('pair.reveal');
    sessionState = NONCE;
    await tick();
    expect(sent.filter((s) => s.type === 'pair.reveal')).toEqual([{ type: 'pair.reveal', args: { offer_id: HEAD.offer_id, n_m: 'N'.repeat(22), sig: 'S'.repeat(70) } }]);
    expect(serverCalls).toContain(`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/reveal`);
    // the number and the two buttons belong to the shell's window: this page has none of them, and asks with the offer id only
    expect(sent.filter((s) => s.type === 'pair.compare')).toEqual([{ type: 'pair.compare', args: { offer_id: HEAD.offer_id } }]);
    expect(container.querySelector('[data-testid="pairing-number"]')).toBeNull();
    expect(text()).not.toMatch(/\d{4} ?\d{4}/); expect(buttons()).not.toContain('같아요'); expect(buttons()).not.toContain('달라요');
    expect(sentTypes()).not.toContain('pair.confirm'); // the web has no way to say «same»
    await tick(); await tick();
    expect(sent.filter((s) => s.type === 'pair.reveal')).toHaveLength(1);
    expect(sent.filter((s) => s.type === 'pair.compare')).toHaveLength(1); // one window per opening
    expect(line()).toBe('컴퓨터에서 확인하는 중…'); // the shell's window was answered [같아요] (pinned)
    pairs = [{ setup_id: HEAD.setup_id }];
    await tick();
    expect(line()).toContain('페어링했어요 · My Mac');
  });

  it('a REAL (slow) OS prompt: the view changes to «revealing» meanwhile, and the answer still goes on to the shell\'s window (not dropped as a stale step)', async () => {
    installShell(); slow.add('pair.reveal');
    await START(); sessionState = NONCE; await tick();
    expect(sent.filter((s) => s.type === 'pair.reveal')).toHaveLength(1);
    await tick(); await tick(); // the screen has re-rendered while the prompt is up
    expect(sent.filter((s) => s.type === 'pair.reveal')).toHaveLength(1); // not asked again meanwhile
    release['pair.reveal'](); await settle();
    expect(serverCalls).toContain(`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/reveal`);
    expect(sent.filter((s) => s.type === 'pair.compare')).toHaveLength(1);
    await tick(); expect(line()).toBe('컴퓨터에서 확인하는 중…');
  });

  it('cancelling while the OS prompt is up: the late answer of that prompt does nothing (no reveal posted, no window)', async () => {
    installShell(); slow.add('pair.reveal');
    await START(); sessionState = NONCE; await tick();
    await press('취소'); expect(buttons()).toContain('QR 찍기');
    release['pair.reveal'](); await settle();
    expect(serverCalls.some((c) => c.endsWith('/reveal'))).toBe(false); expect(sentTypes()).not.toContain('pair.compare'); expect(buttons()).toContain('QR 찍기');
  });

  it('the server already holds the reveal (an earlier answer was lost) → straight to the shell\'s window, no second reveal', async () => {
    installShell(); sessionState = { state: 'revealed', n_m: 'N'.repeat(22), sig: 'S'.repeat(70) };
    await START(); await tick();
    expect(sentTypes()).not.toContain('pair.reveal'); expect(sent.filter((s) => s.type === 'pair.compare')).toHaveLength(1);
  });

  it('[달라요] in the shell\'s window → the server ends the offer, the screen starts over', async () => {
    installShell(); shell['pair.compare'] = { ok: true, pinned: false };
    await START(); sessionState = NONCE; await tick();
    expect(serverCalls).toContain(`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`);
    expect(buttons()).toContain('QR 찍기');
  });

  it('the shell\'s window closed with no answer → «숫자를 확인하지 않았어요» + [숫자 다시 보기] → the window opens again (the same session)', async () => {
    installShell(); shell['pair.compare'] = { ok: false, code: 'cancelled' };
    await START(); sessionState = NONCE; await tick();
    expect(line()).toBe('숫자를 확인하지 않았어요'); expect(buttons()).toContain('숫자 다시 보기');
    expect(sent.filter((s) => s.type === 'pair.reveal')).toHaveLength(1);
    shell['pair.compare'] = { ok: true, pinned: true };
    await press('숫자 다시 보기'); await tick();
    expect(sent.filter((s) => s.type === 'pair.compare')).toHaveLength(2);
    expect(sent.filter((s) => s.type === 'pair.reveal')).toHaveLength(1); // not revealed twice
    expect(line()).toBe('컴퓨터에서 확인하는 중…');
  });

  it('the person closes the OS prompt → «확인하지 않아서…» + [다시 확인] → the same nonce is asked again (a second prompt)', async () => {
    installShell();
    shell['pair.reveal'] = { ok: false, code: 'cancelled' };
    await START(); sessionState = NONCE; await tick();
    expect(line()).toBe('확인하지 않아서 페어링을 이어 가지 못했어요');
    expect(buttons()).toContain('다시 확인');
    expect(serverCalls.some((c) => c.endsWith('/reveal'))).toBe(false); // nothing went up
    shell['pair.reveal'] = REVEAL_OK;
    await press('다시 확인'); await tick();
    expect(sent.filter((s) => s.type === 'pair.reveal')).toHaveLength(2);
    expect(sent.filter((s) => s.type === 'pair.compare')).toHaveLength(1);
  });

  it('[취소] while waiting ends the offer at the server and starts over (no reveal was made)', async () => {
    installShell();
    await START(); await tick();
    await press('취소');
    expect(serverCalls).toContain(`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`);
    expect(buttons()).toContain('QR 찍기'); expect(sentTypes()).not.toContain('pair.reveal');
  });

  it('the offer ended while waiting (burned) → «페어링하지 못했어요…» with [다시 찍기]; no reveal was made', async () => {
    installShell();
    await START(); sessionState = { state: 'burned', n_m: null, sig: null }; await tick();
    expect(line()).toBe('페어링하지 못했어요 — 컴퓨터에서 새 QR을 만들어 다시 찍어 주세요');
    expect(buttons()).toContain('다시 찍기'); expect(sentTypes()).not.toContain('pair.reveal');
  });

  it('after the shell pinned, the offer ending (the computer said «different») → the same line', async () => {
    installShell();
    await START(); sessionState = NONCE; await tick();
    sessionState = { state: 'burned', n_m: null, sig: null }; await tick();
    expect(line()).toBe('페어링하지 못했어요 — 컴퓨터에서 새 QR을 만들어 다시 찍어 주세요');
  });

  it('the key store not answering at the commitment → its own line (nothing sent to the server)', async () => {
    installShell();
    shell['pair.commit'] = { ok: false, code: 'vault_unavailable' };
    await START();
    expect(line()).toBe('폰이 아직 준비되지 않았어요 — 잠시 뒤 다시 해 주세요');
    expect(serverCalls.some((c) => c.endsWith('/commit'))).toBe(false);
  });

  it('the key store not answering when the shell\'s window is answered → a line and [숫자 다시 보기]', async () => {
    installShell(); shell['pair.compare'] = { ok: false, code: 'vault_unavailable' };
    await START(); sessionState = NONCE; await tick();
    expect(text()).toContain('폰이 아직 준비되지 않았어요'); expect(buttons()).toContain('숫자 다시 보기');
  });

  it('another window of the phone app is up (busy) → its own line and [숫자 다시 보기]', async () => {
    installShell(); shell['pair.compare'] = { ok: false, code: 'busy' };
    await START(); sessionState = NONCE; await tick();
    expect(line()).toBe('폰 앱에 다른 창이 열려 있어요 — 닫은 뒤 다시 눌러 주세요'); expect(buttons()).toContain('숫자 다시 보기');
  });

  it('English copy', async () => {
    installShell(); shell['pair.compare'] = { ok: false, code: 'cancelled' };
    await render('en'); await press('Scan QR'); await press('Pair'); sessionState = NONCE; await tick();
    expect(text()).toContain("The number wasn't checked"); expect(buttons()).toContain('Show the number again');
  });

  it('an OLD QR (no version) pairs the old way: the MAC, the offer — not one call of the new procedure', async () => {
    installShell();
    const { version: _v, ...old } = HEAD; void _v;
    shell['pair.scan'] = { ok: true, ...old }; shell['pair.mac'] = { ok: true, mac: 'MAC' };
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
      serverCalls.push(key);
      if (key === 'POST /api/remote-devices') return res(201, { id: KEY_ID });
      if (key === 'GET /api/remote-devices') return res(200, { devices: [{ id: KEY_ID, pairs: [] }] });
      if (key === 'POST /api/remote-devices/pairing-offers') return res(202, { state: 'sent' });
      if (key === 'GET /api/remote-devices/pairing-target') return res(404, {});
      throw new Error(`unexpected ${key}`);
    });
    await render(); await press('QR 찍기'); await press('페어링');
    expect(sentTypes()).toContain('pair.mac'); expect(sentTypes().some((t) => t === 'pair.commit' || t === 'pair.reveal' || t === 'pair.compare')).toBe(false);
    expect(serverCalls.some((c) => c.includes('pairing-sessions'))).toBe(false);
  });
});
