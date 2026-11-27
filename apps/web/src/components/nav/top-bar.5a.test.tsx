// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · PO 11-27) — from lg the top bar is three zones: the PATH on the left (org › project-or-place › the screen's own title) · a SEARCH field in the middle that opens ⌘K · the buttons on the right.
// jsdom has no layout: this pins what is drawn (text · the door · the hint · which classes keep the phone as it was); the real boxes at 1440 / 1280 / 1100 / 390 are measured in e2e/top-bar-zones.5031.layout.spec.ts.
// A click test cannot prove the OS drags the window — it proves the controls inside the drag strip are real, enabled and reachable (the `no-drag` computation is measured in the layout spec).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { pathnameRef, navigated } = vi.hoisted(() => ({ pathnameRef: { current: '/org-briefing' }, navigated: [] as string[] }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
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

async function mount(opts: { pathname: string; title?: React.ReactNode; extra?: (m: { TopBarSlot: typeof import('./top-bar-slot').TopBarSlot; flat: typeof import('./flat-tab-top-bar') }) => React.ReactNode; withPalette?: boolean; messages?: typeof koMessages; locale?: string; withOrg?: boolean; projectId?: string | undefined }) {
  pathnameRef.current = opts.pathname;
  vi.resetModules();
  const { TopBar } = await import('./top-bar');
  const { TopBarProvider } = await import('./top-bar-context');
  const { TopBarSlot } = await import('./top-bar-slot');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const flat = await import('./flat-tab-top-bar');
  const { CommandPaletteProvider, useCommandPalette } = await import('@/components/command-palette/command-palette-context');
  function OpenState() { return <span data-testid="palette-open">{String(useCommandPalette().open)}</span>; }
  const bar = (
    <TopBarProvider>
      <SidebarProvider>
        <TopBar orgId={opts.withOrg === false ? undefined : 'o1'} orgMemberships={ORGS} projectId={'projectId' in opts ? opts.projectId : 'p1'} projectMemberships={PROJECTS} />
        {opts.title !== undefined ? <TopBarSlot title={opts.title} /> : null}
        {opts.extra ? opts.extra({ TopBarSlot, flat }) : null}
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
/** the path as a person reads it: the items of the path list (the crumbs, then the title as the last item) */
function pathText(): string {
  return [...container.querySelectorAll('[data-testid="top-bar-path"] li')].map((li) => li.textContent!.trim()).filter(Boolean).join(' › ');
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

  it('the path is a labelled navigation with the crumbs as a list; the place is a link to its first screen; the organization and the project are switcher buttons (5a-2), not links', async () => {
    await mount({ pathname: '/organization/workforce/runs', title: <span>실행 기록</span> });
    const nav = container.querySelector('[data-testid="top-bar-path"]')!;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('현재 위치');
    // (5a-2: the organization crumb used to be a link home; going home is the place crumb's and the icon bar's job now)
    expect([...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['에이전트', '/organization/workforce?p=p1']]);
    expect(nav.querySelector('[data-testid="top-bar-switcher-org"]')!.getAttribute('aria-haspopup')).toBe('menu');
    await mount({ pathname: '/acme/sprintable/flow', title: <span>흐름</span> });
    const crumbs = container.querySelectorAll('[data-testid="top-bar-path"] li[data-crumb]');
    expect(crumbs[1]!.querySelector('a')).toBeNull();
    expect(crumbs[1]!.querySelector('[data-testid="top-bar-switcher-project"]')).not.toBeNull();
  });

  it('a breadcrumb control is a real, enabled link: pressing it goes to the crumb\'s place (a jsdom press cannot prove the OS drag — see the layout spec for `no-drag`)', async () => {
    await mount({ pathname: '/organization/workforce/runs', title: <span>실행 기록</span> });
    const links = container.querySelectorAll<HTMLAnchorElement>('[data-testid="top-bar-path"] a');
    expect(links).toHaveLength(1); // the place; the organization is a switcher button (5a-2)
    await act(async () => { links[0]!.click(); });
    expect(navigated).toEqual(['/organization/workforce?p=p1']);
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
    // the path list: from lg a row of crumbs + the title; below lg the nav and the list are `display: contents`, the leading crumbs are hidden, the title item is the bar's own flex item
    const nav = container.querySelector('[data-testid="top-bar-path"]')!;
    expect(nav.className.split(/\s+/)).toEqual(expect.arrayContaining(['contents', 'lg:flex']));
    expect(nav.querySelector('ol')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['contents', 'lg:flex']));
    for (const crumb of nav.querySelectorAll('li[data-crumb]')) expect(crumb.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:flex']));
    expect(container.querySelector('[data-testid="top-bar-center"]')!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
    expect(container.querySelector('[data-testid="top-bar-search"]')!.parentElement!.className).toContain('lg:hidden');
    expect(container.querySelector('[data-testid="top-bar-left"]')!.className.split(/\s+/)).toContain('contents');
    expect(container.querySelector('[data-testid="top-bar-title"]')!.tagName).toBe('LI');
    expect(container.querySelector('[data-testid="top-bar-title"]')!.parentElement!.tagName).toBe('OL');
    expect(container.querySelector('h1')!.parentElement).toBe(container.querySelector('[data-testid="top-bar-title"]')); // the title element is still the title item's own child (the phone's truncate rule lives on it)
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
    expect(navigated).toEqual(['/organization/workforce?p=p1']);
  });
});

// ───────────────────────── codex round 1 (5a) ─────────────────────────
describe('TopBar 5a — the title is the path\'s LAST list item (aria-current) and keeps its own element', () => {
  it('⭐the current title is the last <li aria-current="page"> of the path list; the crumbs before it carry no aria-current; an h1 stays an h1 inside it', async () => {
    await mount({ pathname: '/inbox', title: <h1>결재함</h1> });
    const items = [...container.querySelectorAll('[data-testid="top-bar-path"] ol > li')];
    expect(items.at(-1)).toBe(container.querySelector('[data-testid="top-bar-title"]'));
    expect(items.at(-1)!.getAttribute('aria-current')).toBe('page');
    expect(items.slice(0, -1).every((li) => !li.hasAttribute('aria-current'))).toBe(true);
    expect(items.at(-1)!.querySelector('h1')!.textContent).toBe('결재함');
  });
});

describe('TopBar 5a — the path keeps its navigation / list meaning where `display: contents` would drop it (WebKit)', () => {
  it('⭐the nav, the list and every item carry their roles explicitly (the phone lays them out with `display: contents`; WebKit drops the implicit roles of such elements)', async () => {
    await mount({ pathname: '/organization/workforce/runs', title: <span>실행 기록</span> });
    const navs = container.querySelectorAll('[role="navigation"][aria-label="현재 위치"]');
    expect(navs).toHaveLength(1);
    expect(navs[0]!.tagName).toBe('NAV');
    const lists = navs[0]!.querySelectorAll('[role="list"]');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.tagName).toBe('OL');
    const items = [...lists[0]!.children];
    expect(items.length).toBeGreaterThanOrEqual(3); // org · place · the title
    expect(items.every((li) => li.tagName === 'LI' && li.getAttribute('role') === 'listitem')).toBe(true);
    // the name of the navigation is still the label (not replaced by the role)
    expect(navs[0]!.getAttribute('aria-label')).toBe('현재 위치');
  });
});

describe('TopBar 5a — `titleText` (a title that is a component has no words an element scan can read)', () => {
  it('⭐an explicit titleText wins over the element\'s own text: a component title that says the place\'s name leaves the place crumb out', async () => {
    await mount({ pathname: '/organization/workforce', extra: ({ flat }) => <flat.TitleTopBarSlot title={<flat.AgentsTopBarTitle />} useText={flat.useAgentsTopBarTitleText} showContextChip /> });
    expect(pathText()).toBe('올리베이라 조직 › 에이전트'); // not «… › 에이전트 › 에이전트»
  });

  it('without titleText the element\'s own text is the fallback (the older publishers keep working)', async () => {
    await mount({ pathname: '/organization/workforce', title: <h1>에이전트</h1> });
    expect(pathText()).toBe('올리베이라 조직 › 에이전트');
  });
});

describe('TopBar 5a — a settings sub-screen with no title publisher ends the path at 조직 › 설정', () => {
  it('⭐/settings/integrations: the crumbs are the whole path, the title item is empty (and hidden from lg — no blank item, no dangling separator)', async () => {
    await mount({ pathname: '/settings/integrations' });
    expect(pathText()).toBe('올리베이라 조직 › 설정');
    const li = container.querySelector('[data-testid="top-bar-title"]')!;
    expect(li.textContent).toBe('');
    expect(li.className.split(/\s+/)).toContain('lg:empty:hidden');
  });
});

describe('TopBar 5a — a slot published for another path is stale (never shows the old screen\'s name under the new path)', () => {
  it('⭐titleIsStale: stamped for A and the path is B → stale; same path · an unstamped slot · no path known (a bare test) → not', async () => {
    const { titleIsStale } = await import('./top-bar-context');
    expect([titleIsStale('/a', '/b'), titleIsStale('/a', '/a'), titleIsStale(undefined, '/b'), titleIsStale('/a', undefined)]).toEqual([true, false, false, false]);
  });

  it('⭐path A → B: the old title is marked stale on the frame the path changes, and the new screen\'s own publish clears it; a slot that lives across both paths (a layout\'s) is stamped fresh by the path change', async () => {
    vi.resetModules();
    const { TopBar } = await import('./top-bar');
    const { TopBarProvider, useTopBar } = await import('./top-bar-context');
    const { TopBarSlot } = await import('./top-bar-slot');
    const { SidebarProvider } = await import('@/components/ui/sidebar');
    const { CommandPaletteProvider } = await import('@/components/command-palette/command-palette-context');
    // a publisher that publishes ONCE (no re-stamp): the frame between «the path changed» and «the new screen published»
    function PublishOnce({ text }: { text: string }) {
      const { setSlot, pathname } = useTopBar();
      const [done, setDone] = React.useState(false);
      React.useEffect(() => { if (!done) { setSlot({ title: <span>{text}</span>, actions: null, slotPath: pathname }); setDone(true); } }, [done, pathname, setSlot, text]);
      return null;
    }
    const tree = (path: string, children: React.ReactNode) => (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <CommandPaletteProvider><TopBarProvider pathname={path}><SidebarProvider>
          <TopBar orgId="o1" orgMemberships={ORGS} projectId="p1" projectMemberships={PROJECTS} />
          {children}
        </SidebarProvider></TopBarProvider></CommandPaletteProvider>
      </NextIntlClientProvider>
    );
    const title = () => container.querySelector('[data-testid="top-bar-title"]') as HTMLElement;
    pathnameRef.current = '/inbox';
    await act(async () => { root.render(tree('/inbox', <PublishOnce key="a" text="결재함" />)); });
    expect(title().textContent).toBe('결재함');
    expect(title().hasAttribute('data-stale-title')).toBe(false);
    // the path changes to B; the page of B has not published yet (its publisher is still A's)
    pathnameRef.current = '/chats';
    await act(async () => { root.render(tree('/chats', <PublishOnce key="a" text="결재함" />)); });
    expect(title().hasAttribute('data-stale-title'), 'A\'s name under B\'s path is marked stale').toBe(true);
    expect(title().className).toContain('lg:data-[stale-title]:invisible'); // from lg the stale name is not painted
    // B's screen publishes (a new publisher instance, stamped for B)
    await act(async () => { root.render(tree('/chats', <PublishOnce key="b" text="대화" />)); });
    expect(title().textContent).toBe('대화');
    expect(title().hasAttribute('data-stale-title')).toBe(false);
    // a real TopBarSlot that lives across the change publishes again for the new path: never stale
    // (ONE title element for both renders — a layout whose title does not change: only the path change can make the slot publish again)
    const layoutTitle = <span>층</span>;
    pathnameRef.current = '/inbox';
    await act(async () => { root.render(tree('/inbox', <TopBarSlot key="layout" title={layoutTitle} />)); });
    pathnameRef.current = '/more';
    await act(async () => { root.render(tree('/more', <TopBarSlot key="layout" title={layoutTitle} />)); });
    expect(title().textContent).toBe('층');
    expect(title().hasAttribute('data-stale-title')).toBe(false);
  });
});

describe('TopBar 5a — the buttons group is marked for the desktop app\'s no-drag', () => {
  it('⭐the page\'s actions, the phone icon, the people / what\'s new buttons and the bell all sit inside ONE `data-no-drag` group', async () => {
    await mount({ pathname: '/organization/workforce/runs', extra: ({ TopBarSlot }) => <TopBarSlot title={<span>실행</span>} actions={<button type="button" data-testid="action-probe">액션</button>} /> });
    const group = container.querySelector('[data-testid="top-bar-buttons"]')!;
    expect(group.hasAttribute('data-no-drag')).toBe(true);
    expect(group.contains(container.querySelector('button[aria-label^="알림"]'))).toBe(true);
    expect(group.contains(container.querySelector('[data-testid="top-bar-search"]'))).toBe(true);
    expect(group.contains(container.querySelector('[data-testid="action-probe"]'))).toBe(true);
  });
});
