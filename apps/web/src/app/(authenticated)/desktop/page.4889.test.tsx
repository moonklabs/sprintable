// @vitest-environment jsdom
//
// story 4889 (UI-6 · W7~W10 · AC3 §2 «이 컴퓨터» 화면째) — `/desktop` is one composition, not six stacked cards: a head, two columns (left: the app on this Mac · right: the phone), then the connected
// computers across the full width. And the cards share one grammar (title scale · padding). These tests pin the SHAPE (where each piece sits) — each card's own behaviour has its own tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/components/desktop/desktop-download-card', () => ({ DesktopDownloadCard: () => null }));
vi.mock('@/components/desktop/desktop-devices', () => ({ DesktopDevices: () => null }));

type El = { type?: unknown; props?: { children?: unknown; className?: string; [k: string]: unknown } };
const kids = (n: unknown): El[] => (Array.isArray(n) ? n.flatMap(kids) : n && typeof n === 'object' ? [n as El] : []);
const comps = (n: unknown): unknown[] => kids(n).flatMap((e) => (typeof e.type === 'function' ? [e.type] : comps(e.props?.children)));
function byId(n: unknown, id: string): El | null {
  for (const e of kids(n)) {
    if (e.props?.['data-testid'] === id) return e;
    const inner = byId(e.props?.children, id);
    if (inner) return inner;
  }
  return null;
}

const KEYS = ['SPRINTABLE_EMBEDDED', 'DESKTOP_DOWNLOAD_ENABLED'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); process.env.DESKTOP_DOWNLOAD_ENABLED = 'true'; });
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.resetModules();
});

async function pageWith(embedded: string | undefined): Promise<El> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  vi.resetModules();
  const { default: DesktopPage } = await import('./page');
  // 4913: the page is <DesktopScreenTitle/> + <PageFrame width="wide"> — the composition below is the frame's
  const [, frame] = (DesktopPage() as unknown as { props: { children: unknown[] } }).props.children;
  return frame as El;
}

describe('[SID:4913] /desktop — the title is the top bar\'s (not the body\'s)', () => {
  it('the page starts with the screen title, then the frame; no heading inside the frame', async () => {
    delete process.env.SPRINTABLE_EMBEDDED; vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    const { DesktopScreenTitle } = await import('@/components/desktop/desktop-screen-title');
    const { PageFrame } = await import('@/components/ds/page-frame');
    const [title, frame] = (DesktopPage() as unknown as { props: { children: El[] } }).props.children;
    expect(title.type).toBe(DesktopScreenTitle);
    expect(frame.type).toBe(PageFrame);
    const { DesktopPageHead } = await import('@/components/desktop/desktop-page-head');
    expect(comps(frame.props?.children)[0]).toBe(DesktopPageHead);
  });
});

describe('[SID:4889] /desktop — the screen is one composition', () => {
  it('hosted: a head first, then two columns (app · phone), and the connected computers OUTSIDE the columns, across the full width', async () => {
    const page = await pageWith(undefined);
    const { DesktopPageHead } = await import('@/components/desktop/desktop-page-head');
    const { DesktopOpenAppCard } = await import('@/components/desktop/desktop-open-app-card');
    const { DesktopDownloadCard } = await import('@/components/desktop/desktop-download-card');
    const { DesktopRemoteControlCard } = await import('@/components/desktop/desktop-remote-control-card');
    const { DesktopRemoteDevices } = await import('@/components/desktop/desktop-remote-devices');
    const { PhoneSessionManagement } = await import('@/components/desktop/phone-session-management');
    const { DesktopDevices } = await import('@/components/desktop/desktop-devices');
    expect(page.props?.width).toBe('wide');
    expect(comps(page.props?.children)[0]).toBe(DesktopPageHead);
    const columns = byId(page, 'desktop-columns')!;
    expect(columns.props?.className).toContain('lg:grid-cols-2');
    // a column whose cards all draw nothing (a person with no org: no phone cards) must not leave an empty half
    expect(byId(page, 'desktop-col-app')!.props?.className).toContain('empty:hidden');
    expect(byId(page, 'desktop-col-phone')!.props?.className).toContain('empty:hidden');
    expect(comps(byId(page, 'desktop-col-app')!.props?.children)).toEqual([DesktopOpenAppCard, DesktopDownloadCard]);
    expect(comps(byId(page, 'desktop-col-phone')!.props?.children)).toEqual([DesktopRemoteControlCard, DesktopRemoteDevices, PhoneSessionManagement]);
    expect(comps(columns.props?.children)).not.toContain(DesktopDevices);
    expect(comps(page.props?.children).at(-1)).toBe(DesktopDevices);
  });

  it('local mode: the phone column is the one guidance card, and no connected-computers list', async () => {
    const page = await pageWith('1');
    const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice');
    expect(comps(byId(page, 'desktop-col-phone')!.props?.children)).toEqual([PhoneRelayLocalNotice]);
    const { DesktopDevices } = await import('@/components/desktop/desktop-devices');
    expect(comps(page.props?.children)).not.toContain(DesktopDevices);
  });

  it('the head says what the screen holds (ko · en keys exist)', async () => {
    for (const l of ['ko', 'en']) {
      const d = JSON.parse(readFileSync(join(__dirname, `../../../../messages/${l}.json`), 'utf-8')).desktop;
      expect(typeof d.pageTitle).toBe('string');
      expect(d.pageTitle).toBe(JSON.parse(readFileSync(join(__dirname, `../../../../messages/${l}.json`), 'utf-8')).nav.desktopApp); // 4913: one name — the sidebar's
      expect(typeof d.pageNote).toBe('string');
    }
  });
});

describe('[SID:4889] /desktop — the cards share one grammar (source pins)', () => {
  const src = (f: string) => readFileSync(join(__dirname, `../../../components/desktop/${f}`), 'utf-8');
  const TITLE = 'text-ds-card-title font-semibold text-ds-ink';
  it.each([
    ['desktop-open-app-card.tsx', "t('openAppTitle')"],
    ['desktop-download-card.tsx', "t('title')"],
    ['desktop-remote-control-card.tsx', "t('title')"],
    ['desktop-remote-devices.tsx', "t('title')"],
    ['desktop-devices.tsx', "t('title')"],
    ['phone-session-management.tsx', "t('title')"],
    ['phone-relay-local-notice.tsx', "t('title')"],
  ])('%s: the title is the one scale (%s)', (file, call) => {
    const re = new RegExp(`<(?:p|h2)\\b[^>]*className="([^"]*)"[^>]*>\\s*\\{${call.replace(/[()']/g, (c) => `\\${c}`)}\\}`);
    const m = src(file).match(re);
    expect(m, file).toBeTruthy();
    expect(m![1]).toContain(TITLE);
    expect(m![1]).not.toMatch(/text-base|font-medium|text-ds-body/);
    // the e2e contrast guard (desktop-phone-tab.4891.layout.spec) refuses these bare classes on a drawn card — the title scale is the ds token
    expect(m![1]).not.toMatch(/(^|\s)(text-xs|text-sm|text-muted-foreground|text-foreground)(\s|$)/);
  });
  it('the action cards share one padding (p-4) — no p-6 left on the remote-control card or the guidance card', () => {
    expect(src('desktop-remote-control-card.tsx')).not.toMatch(/Card[^>]*\bp-6\b/);
    expect(src('phone-relay-local-notice.tsx')).not.toMatch(/\bp-6\b/);
  });
});
