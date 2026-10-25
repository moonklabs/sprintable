// @vitest-environment jsdom
// story 4780 — every entry to the phone's pairing screen links through `usePairHref`: it carries the page it stands on, so that screen's [Close] can come back to it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => `${href}${href.includes('?') ? '&' : '?'}p=proj-1` }));
const { usePairHref } = await import('./use-pair-href');

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
});
