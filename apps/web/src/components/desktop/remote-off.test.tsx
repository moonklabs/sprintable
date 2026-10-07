// @vitest-environment jsdom
//
// story #4583 (Yuna `4583/copy.md` · card AC5) — «원격 제어» off said the same way everywhere: an owner gets [원격 제어 켜러 가기]
// (to `/desktop#remote-control` — it never flips the switch), anyone else the owner's name in «조직 소유자({owners})». Nothing while
// it is on. The approvals line only with a connected computer. The chat line stays only while the agent works or waits (PO 04:11Z).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
let orgId = 'org-a';
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => {} }));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'Asia/Seoul' }));
const { formatOwners, markArrival } = await import('./remote-off');
const { AgentPermissionRequests } = await import('@/components/inbox/agent-permission-requests');
const { DesktopRemoteControlCard } = await import('./desktop-remote-control-card');
const { AgentSessionStrip } = await import('@/components/chat/agent-session-strip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Org { enabled: boolean; can_change: boolean; owner_names: string[]; connected_computers: number }
const OFF: Org = { enabled: false, can_change: false, owner_names: ['송윤재'], connected_computers: 1 };
let org: Org = OFF;
let session: Record<string, unknown> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let container: HTMLDivElement;
let root: Root;
let n = 0;
beforeEach(() => {
  orgId = `org-${++n}`; // the org value is kept per org id while shown — a fresh id per test reads it again
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.endsWith('/remote-control')) return json(200, { data: { enabled_at: null, ...org } });
    if (url.includes('/desktop-session')) return json(200, { device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: !org.enabled ? false : true, pending_permission_request_id: null, ...session });
    if (url.includes('permission')) return json(200, { requests: [] });
    throw new Error(`unexpected ${url}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  org = OFF;
  session = {};
  window.history.replaceState(null, '', '/');
});

async function render(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const link = () => q('remote-off-link');

describe('the en «and n others» is a real plural (en plural guard · story #4223)', () => {
  it('3 owners → «and 2 others» · the en n = 1 form → «and 1 other»', async () => {
    const { createTranslator } = await import('next-intl');
    const t = createTranslator({ locale: 'en', messages: enMessages, namespace: 'remoteControlOff' });
    expect(formatOwners(['Song Yunjae', 'B', 'C'], (first, k) => t('ownersMore', { first, n: k }))).toBe('Song Yunjae and 2 others');
    expect(t('ownersMore', { first: 'Song Yunjae', n: 1 })).toBe('Song Yunjae and 1 other');
  });
});

describe('formatOwners (Yuna: 1 «A» · 2 «A · B» · 3+ «A 외 n명»)', () => {
  const more = (first: string, k: number) => `${first} 외 ${k}명`;
  it.each([
    [[], ''],
    [['송윤재'], '송윤재'],
    [['송윤재', '윤도선'], '송윤재 · 윤도선'],
    [['송윤재', '윤도선', 'C', 'D'], '송윤재 외 3명'],
  ])('%j → «%s»', (names, expected) => { expect(formatOwners(names, more)).toBe(expected); });
});

describe('결재함 line (Yuna row 4 · only off + a connected computer)', () => {
  it('not owner: the line with the owner name, no link', async () => {
    await render(<AgentPermissionRequests />);
    expect(q('agent-permission-remote-off')?.textContent).toBe('원격 제어가 꺼져 있어 데스크톱 에이전트의 권한 요청이 여기로 오지 않아요 — 조직 소유자(송윤재)가 켤 수 있어요');
    expect(link()).toBeNull();
  });

  it('owner: the line without names, and the link on its own row to the card', async () => {
    org = { ...OFF, can_change: true };
    await render(<AgentPermissionRequests />);
    expect(q('agent-permission-remote-off')?.querySelector('p')?.textContent).toBe('원격 제어가 꺼져 있어 데스크톱 에이전트의 권한 요청이 여기로 오지 않아요');
    expect(link()?.textContent).toBe('원격 제어 켜러 가기');
    expect(link()?.getAttribute('href')).toBe('/desktop#remote-control');
  });

  it('no line when on, or when the org never connected a computer', async () => {
    org = { ...OFF, enabled: true };
    await render(<AgentPermissionRequests />);
    expect(q('agent-permission-remote-off')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    orgId = `org-${++n}`;
    org = { ...OFF, connected_computers: 0 };
    await render(<AgentPermissionRequests />);
    expect(q('agent-permission-remote-off')).toBeNull();
  });

  it('en: two and three-plus owners', async () => {
    org = { ...OFF, owner_names: ['Song Yunjae', 'Yun Doseon'] };
    await render(<AgentPermissionRequests />, 'en');
    expect(q('agent-permission-remote-off')?.textContent).toContain('an organization owner (Song Yunjae · Yun Doseon) can turn it on');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    orgId = `org-${++n}`;
    org = { ...OFF, owner_names: ['Song Yunjae', 'B', 'C'] };
    await render(<AgentPermissionRequests />, 'en');
    expect(q('agent-permission-remote-off')?.textContent).toContain('an organization owner (Song Yunjae and 2 others) can turn it on');
  });

  it('no names known: «조직 소유자가» without an empty parenthesis', async () => {
    org = { ...OFF, owner_names: [] };
    await render(<AgentPermissionRequests />);
    expect(q('agent-permission-remote-off')?.textContent).toBe('원격 제어가 꺼져 있어 데스크톱 에이전트의 권한 요청이 여기로 오지 않아요 — 조직 소유자가 켤 수 있어요');
  });
});

describe('/desktop card (Yuna 5a · 5b · the anchor)', () => {
  it('carries the anchor id every link lands on, and the off line for everyone', async () => {
    await render(<DesktopRemoteControlCard />);
    expect(q('desktop-remote-control')?.id).toBe('remote-control');
    expect(q('desktop-remote-control-off-effect')?.textContent).toBe('꺼져 있으면 권한 요청이 폰으로 오지 않고, 폰에서 멈추거나 지시할 수도 없어요');
    expect(q('desktop-remote-control-owner-only')?.textContent).toBe('원격 제어 · 꺼짐 — 조직 소유자(송윤재)만 켜고 끌 수 있어요');
  });

  it('on: no off line, and the existing «켜짐» line gains the name', async () => {
    org = { ...OFF, enabled: true };
    await render(<DesktopRemoteControlCard />);
    expect(q('desktop-remote-control-off-effect')).toBeNull();
    expect(q('desktop-remote-control-owner-only')?.textContent).toBe('원격 제어 · 켜짐 — 조직 소유자(송윤재)만 켜고 끌 수 있어요');
  });

  it('no names known (an older server · an empty list): the parenthesis goes, never an empty «()» (Yuna 05:19Z)', async () => {
    org = { ...OFF, owner_names: [] };
    await render(<DesktopRemoteControlCard />);
    expect(q('desktop-remote-control-owner-only')?.textContent).toBe('원격 제어 · 꺼짐 — 조직 소유자만 켜고 끌 수 있어요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    orgId = `org-${++n}`;
    const older: Partial<Org> = { ...OFF };
    delete older.owner_names; // a server from before 4583: no owner_names key at all
    org = older as Org;
    await render(<DesktopRemoteControlCard />, 'en');
    expect(q('desktop-remote-control-owner-only')?.textContent).toBe('Remote control · off — only an organization owner can turn it on or off');
    expect(container.textContent).not.toContain('()');
  });

  it('arriving by the link: the owner lands on the switch (focused, not flipped)', async () => {
    org = { ...OFF, can_change: true };
    window.history.replaceState(null, '', '/desktop#remote-control');
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await render(<DesktopRemoteControlCard />);
    const sw = container.querySelector<HTMLElement>('[data-slot="switch"]');
    expect(document.activeElement).toBe(sw);
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toEqual([]);
  });

  it('arriving by the link, not owner: the card takes the focus', async () => {
    window.history.replaceState(null, '', '/desktop#remote-control');
    Element.prototype.scrollIntoView = vi.fn();
    await render(<DesktopRemoteControlCard />);
    expect(document.activeElement).toBe(q('desktop-remote-control'));
  });
});

// AC6 live (run 13 · 07:07Z): the layout test opened `/desktop#remote-control` fresh, and that path focused the switch — the real
// path is a press on the link = a client navigation, where the switch ended unfocused (activeElement = body). These model that
// path: Next's scroll handler moving the focus after the card's effect, and the card mounting before the `#` is on the address.
describe('arrival by an in-app link press (client navigation)', () => {
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  const sw = () => container.querySelector<HTMLElement>('[data-slot="switch"]');

  it('Next 16 blurs the focus on a later commit → the switch takes it back', async () => {
    org = { ...OFF, can_change: true };
    window.history.replaceState(null, '', '/desktop#remote-control');
    Element.prototype.scrollIntoView = vi.fn();
    await render(<DesktopRemoteControlCard />);
    expect(document.activeElement).toBe(sw());
    await act(async () => { (document.activeElement as HTMLElement).blur(); }); // InnerScrollHandlerNew: activeElement.blur()
    await tick();
    expect(document.activeElement).toBe(sw());
    expect(sw()?.getAttribute('aria-checked')).toBe('false');
  });

  it('the older handler focuses the hash target (the card) → the switch takes it back', async () => {
    org = { ...OFF, can_change: true };
    window.history.replaceState(null, '', '/desktop#remote-control');
    Element.prototype.scrollIntoView = vi.fn();
    await render(<DesktopRemoteControlCard />);
    await act(async () => { q('desktop-remote-control')?.focus(); }); // InnerScrollAndFocusHandlerOld: domNode.focus()
    await tick();
    expect(document.activeElement).toBe(sw());
  });

  it('the link press marks the arrival — the card mounting before the # is on the address still lands on the switch', async () => {
    org = { ...OFF, can_change: true };
    Element.prototype.scrollIntoView = vi.fn();
    await render(<AgentPermissionRequests />);
    await act(async () => { link()!.addEventListener('click', (e) => e.preventDefault(), { once: true }); link()!.click(); });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    window.history.replaceState(null, '', '/desktop'); // no `#` yet
    await render(<DesktopRemoteControlCard />);
    expect(document.activeElement).toBe(sw());
  });

  it('the person acts first (a key) — the hold ends and their move stands', async () => {
    org = { ...OFF, can_change: true };
    window.history.replaceState(null, '', '/desktop#remote-control');
    Element.prototype.scrollIntoView = vi.fn();
    await render(<DesktopRemoteControlCard />);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); (document.activeElement as HTMLElement).blur(); });
    await tick();
    expect(document.activeElement).toBe(document.body);
  });

  it('a mark older than 5 s does nothing (a press that opened elsewhere)', async () => {
    org = { ...OFF, can_change: true };
    Element.prototype.scrollIntoView = vi.fn();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    markArrival();
    spy.mockReturnValue(now + 6000);
    window.history.replaceState(null, '', '/desktop');
    await render(<DesktopRemoteControlCard />);
    spy.mockRestore();
    expect(document.activeElement).not.toBe(sw());
  });
});

describe('chat strip line (Yuna row 3 · only while it works or waits)', () => {
  it('not owner: names the owner', async () => {
    await render(<AgentSessionStrip agentId="a-1" conversationId="c-1" />);
    expect(q('agent-session-line')?.textContent).toBe('원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요 — 조직 소유자(송윤재)가 켤 수 있어요');
    expect(link()).toBeNull();
  });

  it('owner: the line and the link on its own row', async () => {
    org = { ...OFF, can_change: true };
    await render(<AgentSessionStrip agentId="a-1" conversationId="c-1" />);
    expect(q('agent-session-line')?.textContent).toBe('원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요');
    expect(link()?.getAttribute('href')).toBe('/desktop#remote-control');
  });

  it('idle: no line at all (PO 04:11Z)', async () => {
    session = { state: 'idle' };
    await render(<AgentSessionStrip agentId="a-1" conversationId="c-1" />);
    expect(q('agent-session-line')).toBeNull();
    expect(link()).toBeNull();
  });
});
