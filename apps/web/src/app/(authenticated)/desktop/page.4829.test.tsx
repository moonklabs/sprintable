// @vitest-environment jsdom
//
// story 4829 (공개 2-⑥ (나)) — the phone relay needs a middle server the app's own server (local mode, SPRINTABLE_EMBEDDED=1) does not have: there the three phone cards of
// `/desktop` are one line of guidance; hosted mode draws exactly the cards it drew before (AC2). The marker is read per request, so each case sets it and loads the page again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/components/desktop/desktop-download-card', () => ({ DesktopDownloadCard: () => null }));
vi.mock('@/components/desktop/desktop-devices', () => ({ DesktopDevices: () => null }));

const KEYS = ['SPRINTABLE_EMBEDDED', 'SPRINTABLE_PUBLIC_ORIGIN', 'DESKTOP_DOWNLOAD_ENABLED'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); process.env.DESKTOP_DOWNLOAD_ENABLED = 'true'; });
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.resetModules();
});

async function cardsWith(embedded: string | undefined, publicOrigin?: string): Promise<unknown[]> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  if (publicOrigin === undefined) delete process.env.SPRINTABLE_PUBLIC_ORIGIN; else process.env.SPRINTABLE_PUBLIC_ORIGIN = publicOrigin;
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

// story 5024 (AC2) — a workspace SERVER HOST (the embedded server WITH a public address, `isServerHost()`) is where the org's owner turns «원격 제어» on: the page opens without the download
// switch, the phone column draws the «원격 제어» card and no other phone card, the app column is as before. The app's own loopback server (no public address) is unchanged.
describe('[SID:5024] /desktop — a server host', () => {
  const PUBLIC = 'https://team.example.com';

  it('a server host: the «원격 제어» card is the one phone card; no guidance line; no device list; the other phone cards wait for the lap on a real server host', async () => {
    const types = await cardsWith('1', PUBLIC);
    const { DesktopOpenAppCard } = await import('@/components/desktop/desktop-open-app-card');
    const { DesktopDownloadCard } = await import('@/components/desktop/desktop-download-card');
    const { DesktopRemoteControlCard } = await import('@/components/desktop/desktop-remote-control-card');
    const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice');
    const { DesktopPageHead } = await import('@/components/desktop/desktop-page-head');
    const { ServerHostAgentCard } = await import('@/components/desktop/server-host-agent-card');
    // story 5024 (AC4): a server host has no app to open or download — its left column is the one «이 서버에 에이전트 붙이기» card
    expect(types).toEqual([DesktopPageHead, ServerHostAgentCard, DesktopRemoteControlCard]);
    expect(types).not.toContain(DesktopOpenAppCard);
    expect(types).not.toContain(DesktopDownloadCard);
    expect(types).not.toContain(PhoneRelayLocalNotice);
  });

  it('[SID:5024 AC4] a server host: the screen\'s title and head are told so («에이전트 연결» — the sidebar\'s name); the card gets this server\'s own address; anything else is told not', async () => {
    const heads = async (embedded: string | undefined, origin?: string) => {
      if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
      if (origin === undefined) delete process.env.SPRINTABLE_PUBLIC_ORIGIN; else process.env.SPRINTABLE_PUBLIC_ORIGIN = origin;
      vi.resetModules();
      const { default: DesktopPage } = await import('./page');
      const [title, frame] = (DesktopPage() as unknown as { props: { children: Array<{ props: Record<string, unknown> }> } }).props.children;
      const head = (frame!.props.children as Array<{ type: unknown; props: Record<string, unknown> }>)[0]!;
      const find = (node: unknown, type: unknown): Array<{ props: Record<string, unknown> }> => {
        if (Array.isArray(node)) return node.flatMap((n) => find(n, type));
        if (!node || typeof node !== 'object') return [];
        const el = node as { type?: unknown; props?: { children?: unknown } };
        return [...(el.type === type ? [el as { props: Record<string, unknown> }] : []), ...find(el.props?.children, type)];
      };
      const { ServerHostAgentCard } = await import('@/components/desktop/server-host-agent-card');
      return { title: title!.props.serverHost, head: head.props.serverHost, cards: find(frame!.props.children, ServerHostAgentCard).map((c) => c.props.origin) };
    };
    expect(await heads('1', PUBLIC)).toEqual({ title: true, head: true, cards: [PUBLIC] });
    for (const [embedded, origin] of [['1', undefined], [undefined, undefined]] as const) {
      expect(await heads(embedded, origin), `embedded ${String(embedded)}`).toEqual({ title: false, head: false, cards: [] });
    }
  });

  it('a server host opens /desktop WITHOUT the download switch (a headless server has none): no redirect; any other server with the switch off still redirects', async () => {
    const { redirect } = await import('next/navigation');
    vi.mocked(redirect).mockClear();
    delete process.env.DESKTOP_DOWNLOAD_ENABLED;
    await cardsWith('1', PUBLIC);
    expect(redirect).not.toHaveBeenCalled();
    for (const [embedded, origin] of [['1', undefined], [undefined, undefined], [undefined, PUBLIC]] as const) { // the app's own server · hosted · a public address WITHOUT the embedded marker (not a server host)
      vi.mocked(redirect).mockClear();
      delete process.env.DESKTOP_DOWNLOAD_ENABLED;
      await cardsWith(embedded, origin);
      expect(redirect, `embedded ${String(embedded)} · public ${String(origin)}`).toHaveBeenCalledTimes(1);
    }
  });

  it('a public address alone is not a server host, and an unusable address is not either: the app\'s own server keeps its guidance card', async () => {
    for (const bad of ['http://team.example.com', 'https://localhost', 'https://127.0.0.1', 'https://team.example.com/app', 'team.example.com', '']) {
      const types = await cardsWith('1', bad);
      const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice'); // (after the page's own module reset: the same instance the page drew)
      expect(types, `public origin ${JSON.stringify(bad)}`).toContain(PhoneRelayLocalNotice);
    }
  });
});
