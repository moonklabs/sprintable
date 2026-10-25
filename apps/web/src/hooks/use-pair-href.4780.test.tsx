// @vitest-environment jsdom
// story 4780 — every entry to the phone's pairing screen links through `usePairHref`: it carries the page it stands on, so that screen's [Close] can come back to it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => `${href}${href.includes('?') ? '&' : '?'}p=proj-1` }));
const { usePairHref } = await import('./use-pair-href');
const { _locationListenerCountForTests } = await import('@/lib/location-store');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Probe() { return <a data-testid="pair" href={usePairHref()}>pair</a>; }
async function hrefAt(url: string): Promise<string | null> {
  window.history.pushState({}, '', url);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  return container.querySelector('a')!.getAttribute('href');
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = null; container = null;
  window.history.pushState({}, '', '/');
});

describe('[SID:4780] usePairHref — the pairing screen\'s address from the page the entry stands on', () => {
  it.each([
    ['Today (the phone card)', '/today?p=proj-1', '/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1'],
    ['a conversation (the chat head)', '/chats/conv-7?p=proj-1', '/desktop/pair?from=%2Fchats%2Fconv-7%3Fp%3Dproj-1&p=proj-1'],
    ['the inbox', '/inbox?tab=gates&p=proj-1', '/desktop/pair?from=%2Finbox%3Fp%3Dproj-1&p=proj-1'],
    ['the Mac screen (원격 기기)', '/desktop', '/desktop/pair?from=%2Fdesktop&p=proj-1'],
    ['the phone start screen', '/phone-start', '/desktop/pair?from=%2Fphone-start&p=proj-1'],
  ])('%s', async (_name, here, want) => {
    expect(await hrefAt(here)).toBe(want);
  });

  it('a page that is not a return target adds nothing (the address as before)', async () => {
    expect(await hrefAt('/board?p=proj-1')).toBe('/desktop/pair?p=proj-1');
  });

  it('the link follows a navigation once the entry draws again (the address is read at each render)', async () => {
    expect(await hrefAt('/today?p=proj-1')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1');
    window.history.pushState({}, '', '/inbox');
    await act(async () => { root!.render(<Probe key="again" />); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1');
  });

  // Kadir lens on 5232: an entry that stays mounted across client navigation (the chat head's strip sits in a layout) must follow the page it is on
  it('a link that stays mounted follows a client-side navigation without being drawn again (pushState · replaceState)', async () => {
    expect(await hrefAt('/today?p=proj-1')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1');
    await act(async () => { window.history.pushState({}, '', '/inbox'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1'); // reverted (no subscription) → still /today
    await act(async () => { window.history.replaceState({}, '', '/chats/conv-7?p=proj-2'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Fchats%2Fconv-7%3Fp%3Dproj-2&p=proj-1');
  });

  it('Back / Forward (popstate) is followed too', async () => {
    await hrefAt('/today');
    await act(async () => { window.history.pushState({}, '', '/inbox'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1');
    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Ftoday&p=proj-1'); // reverted (popstate not listened) → still /inbox
  });

  it('a page that is not a target after the navigation drops the way back; the listener goes with the entry', async () => {
    await hrefAt('/today');
    await act(async () => { window.history.pushState({}, '', '/board'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?p=proj-1');
    const during = _locationListenerCountForTests();
    expect(during).toBeGreaterThan(0);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(_locationListenerCountForTests()).toBe(during - 1); // reverted (never unsubscribed) → the count stays
  });
});
