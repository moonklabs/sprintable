// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';
import { __resetDesktopAppForTest } from '@/lib/desktop-app';

// story 4970 (선생님 11-16): inside the desktop app the «데스크톱 앱» slot offers no download — it says which computer this is and which build runs.
// «Inside the app» is the one mark the app gives (`window.sprintableDesktop.inApp`, never a user-agent guess): the cases below keep the Mac user agent ON in the app, so a card that guessed from it would fail.
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
vi.mock('@/lib/phone-bridge', () => ({
  isPhoneApp: () => false,
  claimPhoneBridge: () => {},
  phoneCall: async () => ({ id: '', ok: false, code: 'not_phone_app' }),
  subscribePhoneApp: () => () => {},
}));
const { DesktopDownloadCard } = await import('./desktop-download-card');
const { DesktopOpenAppCard } = await import('./desktop-open-app-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const wrap = (node: React.ReactNode) => (
  <PhoneBridgeClaim><NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider></PhoneBridgeClaim>
);
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

const MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.2.0', build: 'abc123def', notarized: false,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/0.2.0/Sprintable-Dev-Setup-abc123def-arm64.dmg',
};
let fetchSpy: ReturnType<typeof vi.fn>;
const appBridge = (extra: Record<string, unknown> = {}) => Object.freeze({
  inApp: true as const,
  device: Object.freeze({ name: '윤재의 MacBook' }),
  runtimes: Object.freeze([]),
  pickFolder: async () => null,
  startHere: async () => ({ ok: true as const }),
  setProjectFolder: async () => ({ ok: true as const }),
  ...extra,
});
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };

beforeEach(() => {
  __resetDesktopAppForTest();
  setBridge(undefined);
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => MAC);
  fetchSpy = vi.fn(async () => ({ ok: true, json: async () => MANIFEST, headers: new Headers({ 'x-desktop-download-bucket': 'sprintable-desktop-releases-dev' }) }) as Response);
  vi.stubGlobal('fetch', fetchSpy);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  setBridge(undefined);
  __resetDesktopAppForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('story 4970 — inside the desktop app the download slot says which computer this is', () => {
  it('in the app (even with a Mac user agent): no download card · no button · no manifest asked for — the computer\'s name and the app\'s build instead', async () => {
    setBridge(appBridge({ appVersion: '0.2.31' }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(q('desktop-download-card')).toBeNull();
    expect(q('desktop-download-button')).toBeNull();
    expect(container.querySelector('a[href*="storage.googleapis.com"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q('desktop-this-computer-card')).not.toBeNull();
    expect(q('desktop-this-computer-name')?.textContent).toBe(koMessages.desktop.deviceChipAria.replace('{name}', '윤재의 MacBook'));
    expect(q('desktop-this-computer-version')?.textContent).toBe(koMessages.desktop.versionLabel.replace('{version}', '0.2.31'));
    expect(container.textContent).not.toContain(koMessages.desktop.gatekeeperTitle);
  });

  it('an older app (no build string) still gets the card: the computer\'s name only — the version line is not drawn · a build string that is not a short string is not drawn either', async () => {
    for (const bad of [undefined, '', 12, 'x'.repeat(65)]) {
      __resetDesktopAppForTest();
      setBridge(appBridge(bad === undefined ? {} : { appVersion: bad }));
      await act(async () => { root.render(wrap(<DesktopDownloadCard key={String(bad)} />)); });
      await flush();
      expect(q('desktop-this-computer-card'), String(bad)).not.toBeNull();
      expect(q('desktop-this-computer-name'), String(bad)).not.toBeNull();
      expect(q('desktop-this-computer-version'), String(bad)).toBeNull();
      expect(q('desktop-download-card'), String(bad)).toBeNull();
    }
  });

  it('the title can be left out (the onboarding places draw the card under their own heading)', async () => {
    setBridge(appBridge({ appVersion: '0.2.31' }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard hideTitle />)); });
    await flush();
    expect(q('desktop-this-computer-card')?.textContent).not.toContain(koMessages.desktop.title);
  });

  it('«앱 열기» is not drawn in the app (the person is in it) — and is still drawn in a browser on a Mac (4763 AC5 as it was)', async () => {
    setBridge(appBridge());
    await act(async () => { root.render(wrap(<DesktopOpenAppCard />)); });
    await flush();
    expect(q('desktop-open-app-card')).toBeNull();
    await act(async () => { root.unmount(); });
    __resetDesktopAppForTest();
    setBridge(undefined);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<DesktopOpenAppCard />)); });
    await flush();
    expect(q('desktop-open-app-card')).not.toBeNull();
  });

  it('in a browser (no bridge) the card is what it was: the manifest is asked for and the download button is there', async () => {
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(fetchSpy).toHaveBeenCalledWith('/desktop/downloads/macos.json');
    expect(q('desktop-download-button')).not.toBeNull();
    expect(q('desktop-this-computer-card')).toBeNull();
  });

  it('hydration inside the app (codex): the server HTML was drawn with no bridge, the page then hydrates with the app\'s bridge on it — the download manifest is never asked for and the card ends as «this computer»', async () => {
    const { renderToString } = await import('react-dom/server');
    const { hydrateRoot } = await import('react-dom/client');
    const html = renderToString(wrap(<DesktopDownloadCard />)); // no bridge on the server
    container.innerHTML = html;
    setBridge(appBridge({ appVersion: '0.2.31' })); // the app's preload is there before the page's scripts run
    __resetDesktopAppForTest();
    await act(async () => { hydrateRoot(container, wrap(<DesktopDownloadCard />), { onRecoverableError: () => {} }); });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q('desktop-this-computer-card')).not.toBeNull();
    expect(q('desktop-download-button')).toBeNull();
  });

  it('a page whose bridge is not the app\'s closed shape (inApp not true) is a browser: the download card stays', async () => {
    setBridge({ inApp: false, device: { name: 'x' }, runtimes: [] });
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(q('desktop-this-computer-card')).toBeNull();
    expect(q('desktop-download-button')).not.toBeNull();
  });
});

// the places that draw the card reach it through ONE component — a new place cannot forget the in-app case
describe('story 4970 — one component decides', () => {
  it('every place that draws the download card imports DesktopDownloadCard (the in-app decision lives inside it)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = path.resolve(__dirname, '../..');
    const files = ['app/(authenticated)/desktop/page.tsx', 'app/(authenticated)/settings/page.tsx', 'app/onboarding/connect-step.tsx', 'app/onboarding/first-screen.tsx', 'components/nav/new-project-mac-block.tsx', 'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx'];
    for (const f of files) expect(fs.readFileSync(path.join(src, f), 'utf8'), f).toMatch(/import \{[^}]*DesktopDownloadCard[^}]*\} from '@\/components\/desktop\/desktop-download-card'/);
  });
});
