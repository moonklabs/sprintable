// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · PO 11-27) — from lg the top bar is three zones: the PATH on the left (org › project-or-place › the screen's own title) · a SEARCH field in the middle that opens ⌘K · the buttons on the right.
// jsdom has no layout: this pins what is drawn (text · the door · the hint · which classes keep the phone as it was); the real boxes at 1440 / 1280 / 1100 / 390 are measured in e2e/top-bar-zones.5031.layout.spec.ts.
// A click test cannot prove the OS drags the window — it proves the controls inside the drag strip are real, enabled and reachable (the `no-drag` computation is measured in the layout spec).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { pathnameRef, navigated } = vi.hoisted(() => ({ pathnameRef: { current: '/org-briefing' }, navigated: [] as string[] }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
// next/link needs the app router; this stand-in is a plain anchor that tells where the press would go (the router's job is not under test).
vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: React.ReactNode; onClick?: (e: React.MouseEvent) => void } & Record<string, unknown>) => (
    <a href={href} {...rest} onClick={(e) => { onClick?.(e); e.preventDefault(); navigated.push(href); }}>{children}</a>
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORGS = [{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }];
const PROJECTS = [{ projectId: 'p1', projectName: '스프린터블' }];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  navigated.length = 0;
  pathnameRef.current = '/org-briefing';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  delete (window as { sprintableDesktop?: unknown }).sprintableDesktop;
});

async function mount(opts: { pathname: string; title?: React.ReactNode; withPalette?: boolean; messages?: typeof koMessages; locale?: string; withOrg?: boolean; projectId?: string | undefined }) {
  pathnameRef.current = opts.pathname;
  vi.resetModules();
  const { TopBar } = await import('./top-bar');
  const { TopBarProvider } = await import('./top-bar-context');
  const { TopBarSlot } = await import('./top-bar-slot');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { CommandPaletteProvider, useCommandPalette } = await import('@/components/command-palette/command-palette-context');
  function OpenState() { return <span data-testid="palette-open">{String(useCommandPalette().open)}</span>; }
  const bar = (
    <TopBarProvider>
      <SidebarProvider>
        <TopBar orgId={opts.withOrg === false ? undefined : 'o1'} orgMemberships={ORGS} projectId={'projectId' in opts ? opts.projectId : 'p1'} projectMemberships={PROJECTS} />
        {opts.title !== undefined ? <TopBarSlot title={opts.title} /> : null}
        <OpenState />
      </SidebarProvider>
    </TopBarProvider>
  );
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={opts.locale ?? 'ko'} messages={opts.messages ?? koMessages} timeZone="Asia/Seoul">
        {opts.withPalette === false ? bar : <CommandPaletteProvider>{bar}</CommandPaletteProvider>}
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const bar = () => container.querySelector('[data-testid="top-bar"]') as HTMLElement;
/** the path as a person reads it: the crumbs of the path nav, then the title zone's words */
function pathText(): string {
  const crumbs = [...container.querySelectorAll('[data-testid="top-bar-path"] li')].map((li) => li.textContent!.trim());
  const title = container.querySelector('[data-testid="top-bar-title"]')!.textContent!.trim();
  return [...crumbs, title].filter(Boolean).join(' › ');
}

describe('TopBar 5a — the path (the rule: org › project-or-place › title; the table of the rule is lib/top-bar-path.test.ts)', () => {
  const cases: Array<[string, string, React.ReactNode, string]> = [
    ['홈', '/org-briefing', null, '올리베이라 조직 › 홈'],
    ['홈 · 결재함', '/inbox', <h1 key="t" className="text-sm font-medium">결재함</h1>, '올리베이라 조직 › 홈 › 결재함'],
    ['채팅 list', '/chats', null, '올리베이라 조직 › 채팅'],
    ['에이전트 (the title says the place: once)', '/organization/workforce', <h1 key="t">에이전트</h1>, '올리베이라 조직 › 에이전트'],
    ['설정 · tab', '/settings', <span key="t">프로필</span>, '올리베이라 조직 › 설정 › 프로필'],
    ['project-scoped screen (a flow page)', '/acme/sprintable/flow', <h1 key="t">흐름</h1>, '올리베이라 조직 › 스프린터블 › 흐름'],
    ['chat room: the room is the last crumb', '/chats/room-1', <span key="t">민 · 디디</span>, '올리베이라 조직 › 채팅 › 민 · 디디'],
  ];
  for (const [what, pathname, title, expected] of cases) {
    it(`${what}: ${pathname} → «${expected}»`, async () => {
      await mount({ pathname, title: title ?? undefined });
      expect(pathText()).toBe(expected);
    });
  }

  it('a title that is an h1 stays an h1 (the bar does not copy or change heading semantics); the chat room\'s last crumb is a plain span — never a second h1', async () => {
    await mount({ pathname: '/chats/room-1', title: <span data-testid="room-name">민 · 디디</span> });
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('[data-testid="room-name"]')!.tagName).toBe('SPAN');
    await mount({ pathname: '/inbox', title: <h1>결재함</h1> });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('the path is a labelled navigation with the crumbs as a list; the organization and the place are links to their first screens, the project is plain text', async () => {
    await mount({ pathname: '/organization/workforce/runs', title: <span>실행 기록</span> });
    const nav = container.querySelector('[data-testid="top-bar-path"]')!;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('현재 위치');
    expect([...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['올리베이라 조직', '/org-briefing?p=p1'], ['에이전트', '/organization/workforce?p=p1']]);
    await mount({ pathname: '/acme/sprintable/flow', title: <span>흐름</span> });
    const crumbs = container.querySelectorAll('[data-testid="top-bar-path"] li');
    expect(crumbs[1]!.querySelector('a')).toBeNull();
  });

  it('a breadcrumb control is a real, enabled link: pressing it goes to the crumb\'s place (a jsdom press cannot prove the OS drag — see the layout spec for `no-drag`)', async () => {
    await mount({ pathname: '/organization/workforce/runs', title: <span>실행 기록</span> });
    const links = container.querySelectorAll<HTMLAnchorElement>('[data-testid="top-bar-path"] a');
    await act(async () => { links[1]!.click(); });
    await act(async () => { links[0]!.click(); });
    expect(navigated).toEqual(['/organization/workforce?p=p1', '/org-briefing?p=p1']);
  });

  it('English messages carry the same keys (a Korean word is never the only copy)', async () => {
    await mount({ pathname: '/settings', title: <span>Profile</span>, messages: enMessages as unknown as typeof koMessages, locale: 'en' });
    expect(container.querySelector('[data-testid="top-bar-path"]')!.getAttribute('aria-label')).toBe('You are here');
    expect(container.querySelector('[data-testid="top-bar-search-field"]')!.textContent).toContain('Find');
    expect(pathText()).toBe('올리베이라 조직 › Settings › Profile');
  });
});

describe('TopBar 5a — the search field (a button that opens the ⌘K palette)', () => {
  const field = () => container.querySelector('[data-testid="top-bar-search-field"]') as HTMLButtonElement | null;

  it('⭐it is a BUTTON (not a real input) named «찾기», and pressing it opens the palette (openPalette called)', async () => {
    await mount({ pathname: '/org-briefing' });
    expect(field()!.tagName).toBe('BUTTON');
    expect(field()!.getAttribute('type')).toBe('button');
    expect(container.querySelector('[data-testid="top-bar-center"] input')).toBeNull();
    expect(field()!.textContent).toContain('찾기');
    expect(container.querySelector('[data-testid="palette-open"]')!.textContent).toBe('false');
    await act(async () => { field()!.click(); });
    expect(container.querySelector('[data-testid="palette-open"]')!.textContent).toBe('true');
  });

  it('⭐the hint names the key that really exists: Ctrl K on a computer that is not a Mac, ⌘K on a Mac', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32', userAgentData: undefined });
    await mount({ pathname: '/org-briefing' });
    expect(field()!.querySelector('kbd')!.textContent).toBe('Ctrl K');
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgentData: undefined });
    await mount({ pathname: '/org-briefing' });
    expect(field()!.querySelector('kbd')!.textContent).toBe('⌘K');
  });

  it('no palette provider (a test of the bar alone) = no field; the phone icon is not there either', async () => {
    await mount({ pathname: '/org-briefing', withPalette: false });
    expect(field()).toBeNull();
    expect(container.querySelector('[data-testid="top-bar-search"]')).toBeNull();
  });

  it('the face uses only design-system tokens: height 40 · radius 8 · 1px line · left 12 / right 16 · icon 24 · 12 between · 16 Regular third-grade ink — no raw colour, no alpha, no shadow, no arbitrary pixel', async () => {
    await mount({ pathname: '/org-briefing' });
    const cls = field()!.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['h-ds-control', 'rounded-ds-control', 'border', 'border-ds-line-control', 'bg-ds-surface', 'pl-ds-3', 'pr-ds-4', 'gap-ds-3', 'text-base', 'font-normal', 'text-ds-ink-3']));
    expect(field()!.className).not.toMatch(/shadow|\[[^\]]*px\]|#[0-9a-f]{3,6}|\/\d{1,3}\b|rgb|oklch/i);
    expect(field()!.querySelector('svg')!.getAttribute('width')).toBe('24');
  });
});

describe('TopBar 5a — below lg the bar is as it was (the 5a zones are lg-only classes; the phone keeps chip · title · search icon · bell)', () => {
  it('the path and the field are `hidden lg:…`, the phone search icon is `lg:hidden`, the left zone is `contents` (the title is a direct child of the bar as before), the bar stays 48 high (64 from lg)', async () => {
    await mount({ pathname: '/inbox', title: <h1>결재함</h1> });
    expect(bar().className.split(/\s+/)).toEqual(expect.arrayContaining(['h-12', 'lg:h-ds-bar']));
    expect(container.querySelector('[data-testid="top-bar-path"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
    expect(container.querySelector('[data-testid="top-bar-center"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
    expect(container.querySelector('[data-testid="top-bar-search"]')!.parentElement!.className).toContain('lg:hidden');
    expect(container.querySelector('[data-testid="top-bar-left"]')!.className.split(/\s+/)).toContain('contents');
    expect(container.querySelector('[data-testid="top-bar-title"]')!.parentElement).toBe(container.querySelector('[data-testid="top-bar-left"]'));
    expect(container.querySelector('button[aria-label^="알림"]')).not.toBeNull();
  });
});

describe('TopBar 5a — the desktop app: the strip is the window\'s drag area', () => {
  const bridge = { inApp: true, device: { name: 'Mac' }, runtimes: [], pickFolder: async () => null, startHere: async () => ({ ok: true as const }), setProjectFolder: async () => ({ ok: true as const }) };

  it('⭐inside the desktop app the strip is marked (the stylesheet turns the mark into drag / no-drag); in a browser it is not', async () => {
    await mount({ pathname: '/org-briefing' });
    expect(bar().hasAttribute('data-desktop-app')).toBe(false);
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    await mount({ pathname: '/org-briefing' });
    expect(bar().hasAttribute('data-desktop-app')).toBe(true);
  });

  it('every kind of control inside the strip is reachable by a press: the search field and a crumb link fire their handler, and the bell is an enabled button (inside the app too)', async () => {
    (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = bridge;
    await mount({ pathname: '/organization/workforce/runs', title: <span>실행 기록</span> });
    const bell = container.querySelector<HTMLButtonElement>('button[aria-label^="알림"]')!;
    expect(bell.disabled).toBe(false);
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { bell.click(); });
    expect(bell.getAttribute('aria-expanded')).toBe('true'); // the bell's own handler ran (its panel opened)
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="top-bar-search-field"]')!.click(); });
    expect(container.querySelector('[data-testid="palette-open"]')!.textContent).toBe('true');
    await act(async () => { container.querySelector<HTMLAnchorElement>('[data-testid="top-bar-path"] a')!.click(); });
    expect(navigated).toEqual(['/org-briefing?p=p1']);
  });
});
