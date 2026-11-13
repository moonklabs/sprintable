// @vitest-environment jsdom
//
// story 4829 (공개 2-⑥ (나)) — the phone relay needs a middle server the app's own server (local mode, SPRINTABLE_EMBEDDED=1) does not have: there the three phone cards of
// `/desktop` are one line of guidance; hosted mode draws exactly the cards it drew before (AC2). The marker is read per request, so each case sets it and loads the page again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/components/desktop/desktop-download-card', () => ({ DesktopDownloadCard: () => null }));
vi.mock('@/components/desktop/desktop-devices', () => ({ DesktopDevices: () => null }));

const KEYS = ['SPRINTABLE_EMBEDDED', 'DESKTOP_DOWNLOAD_ENABLED'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); process.env.DESKTOP_DOWNLOAD_ENABLED = 'true'; });
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.resetModules();
});

async function cardsWith(embedded: string | undefined): Promise<unknown[]> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  vi.resetModules();
  const { default: DesktopPage } = await import('./page');
  return componentTypes(frameOf(DesktopPage()).props.children);
}
// 4913: the page is the top-bar title + the frame (PageFrame) — the cards live inside the frame
function frameOf(page: unknown): { props: { children?: unknown; width?: string } } {
  const [, frame] = (page as { props: { children: unknown[] } }).props.children;
  return frame as { props: { children?: unknown; width?: string } };
}

// story 4889: the page is one composition (head · two columns · devices) — read its function components in document order, whatever DOM wrappers hold them
function componentTypes(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(componentTypes);
  if (!node || typeof node !== 'object') return [];
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === 'function') return [el.type];
  return componentTypes(el.props?.children);
}


describe('[SID:4829] /desktop — the phone cards in local mode', () => {
  it('local mode: the three phone cards are one guidance card (nothing of the phone relay is drawn) and the device list is not drawn (4832)', async () => {
    const types = await cardsWith('1');
    const { DesktopOpenAppCard } = await import('@/components/desktop/desktop-open-app-card');
    const { DesktopDownloadCard } = await import('@/components/desktop/desktop-download-card');
    const { DesktopDevices } = await import('@/components/desktop/desktop-devices');
    const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice');
    const { DesktopPageHead } = await import('@/components/desktop/desktop-page-head');
    // story 4832: and no «연결된 기기» list — a local install has one computer, nothing to list or disconnect
    expect(types).toEqual([DesktopPageHead, DesktopOpenAppCard, DesktopDownloadCard, PhoneRelayLocalNotice]);
    expect(types).not.toContain(DesktopDevices);
  });

  it('hosted mode (AC2): the cards are exactly what they were — the guidance is not drawn', async () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) { // only the exact «1» is local mode, as the web server and the backend read it
      const types = await cardsWith(value);
      const { DesktopOpenAppCard } = await import('@/components/desktop/desktop-open-app-card');
      const { DesktopDownloadCard } = await import('@/components/desktop/desktop-download-card');
      const { DesktopRemoteControlCard } = await import('@/components/desktop/desktop-remote-control-card');
      const { DesktopRemoteDevices } = await import('@/components/desktop/desktop-remote-devices');
      const { PhoneSessionManagement } = await import('@/components/desktop/phone-session-management');
      const { DesktopDevices } = await import('@/components/desktop/desktop-devices');
      const { DesktopPageHead } = await import('@/components/desktop/desktop-page-head');
      expect(types, `SPRINTABLE_EMBEDDED=${String(value)}`).toEqual([DesktopPageHead, DesktopOpenAppCard, DesktopDownloadCard, DesktopRemoteControlCard, DesktopRemoteDevices, PhoneSessionManagement, DesktopDevices]);
    }
  });
});
