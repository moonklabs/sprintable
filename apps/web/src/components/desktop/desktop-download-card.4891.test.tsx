// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 데스크톱/폰 앱 · piece ④) — the download card on ds parts: a ds Card in all three states, the [다운로드] button is a ds Button (primary — `ctaVariant="outline"` is the secondary one), and the first-open guide of an
// un-notarized build is a ds Banner (note tone) carrying the same title · steps · old-Mac line · notice; a notarized build draws none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
vi.mock('@/lib/phone-bridge', () => ({
  isPhoneApp: () => false,
  claimPhoneBridge: () => {},
  phoneCall: async () => ({ id: '', ok: false, code: 'not_phone_app' }),
  subscribePhoneApp: () => () => {},
}));
const { DesktopDownloadCard } = await import('./desktop-download-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => MAC);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const BUCKET = 'sprintable-desktop-releases-dev';
const manifest = (extra: object = {}) => ({ product: 'Sprintable Dev Setup', version: '0.2.99', build: 'abc1234', url: `https://storage.googleapis.com/${BUCKET}/Sprintable.dmg`, ...extra });
const answer = (body: unknown, ok = true) => ({ ok, json: async () => body, headers: new Headers({ 'x-desktop-download-bucket': BUCKET }) }) as Response;
async function draw(node: React.ReactNode) {
  await act(async () => { root.render(<PhoneBridgeClaim><NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider></PhoneBridgeClaim>); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('[SID:4891] DesktopDownloadCard on ds parts', () => {
  it('loading · unavailable · ready are all a ds Card with the same test id', async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { release = r; })));
    await draw(<DesktopDownloadCard />);
    expect(q('desktop-download-card')?.getAttribute('data-slot')).toBe('ds-card'); // loading
    await act(async () => { release(answer(null, false)); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(q('desktop-download-unavailable')?.closest('[data-slot="ds-card"]')).not.toBeNull(); // unavailable
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => answer(manifest())));
    await draw(<DesktopDownloadCard />);
    expect(q('desktop-download-card')?.getAttribute('data-slot')).toBe('ds-card'); // ready
    expect(q('desktop-download-card')?.textContent).toContain(koMessages.desktop.title);
  });

  it('[다운로드] is a ds primary Button on a link; ctaVariant="outline" makes it the secondary one (one screen, one primary)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(manifest())));
    await draw(<DesktopDownloadCard />);
    const primary = q('desktop-download-button')!;
    expect(primary.tagName).toBe('A');
    expect(primary.getAttribute('data-slot')).toBe('ds-button');
    expect(primary.className.split(/\s+/)).toContain('bg-ds-action');
    expect(primary.className).toContain('touch:min-h-ds-touch');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await draw(<DesktopDownloadCard ctaVariant="outline" />);
    const secondary = q('desktop-download-button')!;
    expect(secondary.className.split(/\s+/)).not.toContain('bg-ds-action');
    expect(secondary.className).toContain('border-ds-line-control');
  });

  it('an un-notarized build: the first-open guide is a ds Banner with the title · the two steps · the old-Mac line · the notice; a notarized one has none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(manifest({ notarized: false }))));
    await draw(<DesktopDownloadCard />);
    const banner = q('desktop-download-gatekeeper-title')!.closest('[data-slot="ds-banner"]')!;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('data-tone')).toBe('note');
    expect(q('desktop-download-gatekeeper-title')?.textContent).toBe(koMessages.desktop.gatekeeperTitle);
    expect(q('desktop-download-install-steps')?.querySelectorAll('li')).toHaveLength(2);
    expect(q('desktop-download-old-mac')?.textContent).toBe(koMessages.desktop.installOldMac);
    expect(q('desktop-download-notarization-notice')?.textContent).toBe(koMessages.desktop.notarizationNotice);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => answer(manifest({ notarized: true }))));
    await draw(<DesktopDownloadCard />);
    expect(q('desktop-download-gatekeeper-title')).toBeNull();
    expect(container.querySelector('[data-slot="ds-banner"]')).toBeNull();
    expect(q('desktop-download-button')).not.toBeNull(); // the button stays
  });

  it('a middle click on the button still counts (onAuxClick) and the plain click is told too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(manifest())));
    const told = vi.fn();
    await draw(<DesktopDownloadCard onCta={told} />);
    const a = q('desktop-download-button')!;
    await act(async () => { a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); });
    expect(told).toHaveBeenCalledTimes(1);
    await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); });
    expect(told).toHaveBeenCalledTimes(2);
  });
});
