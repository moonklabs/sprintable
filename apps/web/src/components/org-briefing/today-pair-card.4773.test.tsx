// @vitest-environment jsdom
//
// story 4773 (AC3) — Today, inside the phone app, for a phone paired with nothing: one line and one link to the pairing screen. From Today that is the card (1 press) → [Scan QR]
// (1 press) = two presses to the camera; it was eight. The card is drawn only when the start screen's own read says «paired with nothing» (`no_phone`, and `no_screen_lock` which
// the start screen also treats as «no Mac yet»); reading · a failed read · a paired phone · not the phone app draw nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useDashboardContextMock, fetchWithAuth } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), fetchWithAuth: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

const { TodayPairCard } = await import('./today-pair-card');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetchWithAuth.mockReset();
  useDashboardContextMock.mockReturnValue({ projectId: 'p1', inShell: true });
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

type Answer = { id: string; ok: boolean; code?: string; [k: string]: unknown };
type Call = (type: string, args?: Record<string, unknown>) => Promise<Answer>;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const key = (extra: Partial<Answer> = {}): Answer => ({ id: 'w1', ok: true, key_number: '324 642', ...extra });

/** the server's list of this person's phones, and (when this phone is on it) what it is paired with */
function server(opts: { devices: Array<{ id: string; confirm_number: string }>; startable?: unknown; listOk?: boolean }) {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === '/api/remote-devices') return opts.listOk === false ? json({}, false) : json({ devices: opts.devices });
    if (url.startsWith('/api/desktop/startable')) return json(opts.startable ?? { remote_control: true, computers: [] });
    return json({}, false);
  });
}

async function draw(phoneCall: Call, opts: { inPhoneApp?: boolean; locale?: 'ko' | 'en'; strict?: boolean } = {}) {
  const messages = opts.locale === 'en' ? enMessages : koMessages;
  const tree = (
    <PhoneBridgeContext.Provider value={{ inPhoneApp: opts.inPhoneApp ?? true, phoneCall }}>
      <NextIntlClientProvider locale={opts.locale ?? 'ko'} messages={messages} timeZone="UTC"><TodayPairCard /></NextIntlClientProvider>
    </PhoneBridgeContext.Provider>
  );
  await act(async () => { root.render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree); });
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('[SID:4773] TodayPairCard — a phone paired with nothing gets one line and one way in', () => {
  it('this phone is on no list of the person\'s phones → the card: the line and a link to the pairing screen (flat, with the project)', async () => {
    server({ devices: [] });
    await draw(async () => key());
    expect(q('today-pair-card')).not.toBeNull(); // reverted (not drawn) → fails
    expect(q('today-pair-note')?.textContent).toBe(koMessages.phonePairing.todayNote);
    const link = q('today-pair-link') as HTMLAnchorElement;
    expect(link.textContent).toBe(koMessages.phonePairing.entry); // the pairing screen's own entry words — no new button text
    expect(link.getAttribute('href')).toBe('/desktop/pair?p=p1'); // the address the start screen's «pair» uses · one press → the pairing screen, [Scan QR] is the second
  });

  it('[4780] the link carries the page it stands on (Today) so the pairing screen\'s [Close] comes back to Today', async () => {
    window.history.pushState({}, '', '/today?p=p1');
    try {
      server({ devices: [] });
      await draw(async () => key());
      const link = q('today-pair-link') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dp1&p=p1'); // reverted (no `from`) → '/desktop/pair?p=p1'
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('[4780] on the Today address the app really has with TODAY_V3 off (/org-briefing) the link carries it too — the card lives on that screen', async () => {
    window.history.pushState({}, '', '/org-briefing?p=p1');
    try {
      server({ devices: [] });
      await draw(async () => key());
      const link = q('today-pair-link') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/desktop/pair?from=%2Forg-briefing%3Fp%3Dp1&p=p1'); // reverted (the allow-list names only /today) → '/desktop/pair?p=p1'
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('the list holds another phone but not this one (its check number is not on it) → still the card', async () => {
    server({ devices: [{ id: 'd9', confirm_number: '111 222' }] });
    await draw(async () => key());
    expect(q('today-pair-card')).not.toBeNull();
  });

  it('this phone is on the list (paired) → nothing, and the computers\' list is read for no one else', async () => {
    server({ devices: [{ id: 'd1', confirm_number: '324 642' }] });
    await draw(async () => key());
    expect(q('today-pair-card')).toBeNull(); // «unpaired» for everything → fails
  });

  it('paired, with no computer connected right now → still paired: nothing (the card says «not paired», which would be untrue)', async () => {
    server({ devices: [{ id: 'd1', confirm_number: '324 642' }], startable: { remote_control: true, computers: [] } });
    await draw(async () => key());
    expect(q('today-pair-card')).toBeNull();
  });

  it('the phone has no screen lock (the shell can make no key) → the card too — the start screen reads that as «no Mac yet»; the pairing screen says why', async () => {
    server({ devices: [] });
    await draw(async () => key({ ok: false, code: 'no_screen_lock', key_number: undefined }));
    expect(q('today-pair-card')).not.toBeNull();
  });

  it('a failed read draws nothing — a bridge that refuses, one that throws, a list that cannot be read (no line that may be untrue)', async () => {
    server({ devices: [] });
    await draw(async () => key({ ok: false, code: 'timeout', key_number: undefined }));
    expect(q('today-pair-card')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await draw(async () => { throw new Error('bridge down'); });
    expect(q('today-pair-card')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    server({ devices: [], listOk: false });
    await draw(async () => key());
    expect(q('today-pair-card')).toBeNull();
  });

  it('while the read is out there is no card (no flash that goes away again)', async () => {
    server({ devices: [] });
    let release: (a: Answer) => void = () => {};
    const pending = new Promise<Answer>((resolve) => { release = resolve; });
    await draw(() => pending);
    expect(q('today-pair-card')).toBeNull();
    await act(async () => { release(key()); });
    await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(q('today-pair-card')).not.toBeNull(); // the same read, answered → now it shows
  });

  it('outside the phone app nothing is asked of anyone: no bridge call, no request, no card', async () => {
    server({ devices: [] });
    const call = vi.fn(async () => key());
    await draw(call, { inPhoneApp: false });
    expect(call).not.toHaveBeenCalled(); // asking can make the phone's key — never from a browser tab
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(q('today-pair-card')).toBeNull();
  });

  it('under React StrictMode (the effect runs twice) the shell is asked ONCE — asking can make the phone\'s key', async () => {
    server({ devices: [] });
    const call = vi.fn(async () => key());
    await draw(call, { strict: true });
    expect(call).toHaveBeenCalledTimes(1); // a read per effect run → 2
    expect(fetchWithAuth.mock.calls.filter((c) => c[0] === '/api/remote-devices')).toHaveLength(1);
    expect(q('today-pair-card')).not.toBeNull();
  });

  it('restored from the back-forward cache after the person paired: the page is read again — the card goes (a normal pageshow reads nothing)', async () => {
    server({ devices: [] });
    const call = vi.fn(async () => key());
    await draw(call);
    expect(q('today-pair-card')).not.toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    // not restored (a normal show): nothing is read again
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(call).toHaveBeenCalledTimes(1);
    expect(q('today-pair-card')).not.toBeNull();
    // the person pairs on /desktop/pair and comes back: the page is restored as it was left
    server({ devices: [{ id: 'd1', confirm_number: '324 642' }] });
    await act(async () => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); });
    await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(call).toHaveBeenCalledTimes(2); // a restored page is read again
    expect(q('today-pair-card')).toBeNull(); // the stale «unpaired» kept on a restored page → fails
  });

  it('restored and still unpaired: the card stays (no flash), read again once', async () => {
    server({ devices: [] });
    const call = vi.fn(async () => key());
    await draw(call);
    await act(async () => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); });
    expect(q('today-pair-card')).not.toBeNull(); // while the new read is out, the old answer is still on screen
    await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(call).toHaveBeenCalledTimes(2);
    expect(q('today-pair-card')).not.toBeNull();
  });

  it('another bridge is another phone read: the answer of the first bridge is not shown for the second until it answers', async () => {
    server({ devices: [] });
    await draw(async () => key());
    expect(q('today-pair-card')).not.toBeNull();
    server({ devices: [{ id: 'd1', confirm_number: '555 666' }] });
    // the second bridge has not answered yet: the first bridge's «unpaired» must not stay on screen for it
    await draw(() => new Promise<Answer>(() => {}));
    expect(q('today-pair-card')).toBeNull(); // the old bridge's answer kept on screen while the new read is out → fails
    // …and once the second bridge answers «paired», still nothing
    await draw(async () => key({ key_number: '555 666' }));
    expect(q('today-pair-card')).toBeNull();
  });

  it('the words: the line follows the product\'s word for the phone connection (story 4644: «페어링», never «짝») and the button is the pairing screen\'s own (ko + en)', async () => {
    expect(koMessages.phonePairing.todayNote).toBe('이 폰은 아직 컴퓨터와 페어링되지 않았어요.');
    expect(koMessages.phonePairing.todayNote).not.toContain('짝');
    expect(enMessages.phonePairing.todayNote).toBe("This phone isn't paired with a computer yet.");
    server({ devices: [] });
    await draw(async () => key(), { locale: 'en' });
    expect(q('today-pair-note')?.textContent).toBe(enMessages.phonePairing.todayNote);
    expect(q('today-pair-link')?.textContent).toBe('Pair with a computer');
  });
});
