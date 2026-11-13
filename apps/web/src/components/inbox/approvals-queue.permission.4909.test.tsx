// @vitest-environment jsdom
//
// story 4909 (UI-R1 AC3, 2d-2) — the approvals list gets a section «에이전트 권한 요청» (between «내 손이 필요해요» and «보류 중»), read by the SAME hook the standalone group used; its detail is the same
// PermissionCard; the old block on the inbox tab is gone. What this pins: the rows and their order, that nothing picks a permission row for the person while approvals exist, that a row opens its card,
// that the list still draws when the approvals could not be read (and the «nothing» block does not sit over a list with rows), and — the point of the step — that ONE screen has ONE reader: one read
// of the server list, one 15 s clock, one subscription to the named permission frame (counted per URL / per subscription, so a second reader shows as 2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '../kanban/types';
import type { PermissionRequest } from '@/lib/agent-permissions';

const { useDashboardContextMock, searchRef, live } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  searchRef: { current: '' },
  live: { perm: 0 },
}));
const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('../../app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchRef.current),
}));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));
// a subscription that counts itself: `live.perm` = how many mounted readers listen for the NAMED permission frame (the hook subscribes on mount, unsubscribes on unmount)
vi.mock('@/hooks/use-sse-notifications', async () => {
  const { useEffect } = await import('react');
  return {
    useSseNotifications: (o: { extraEventNames?: string[] }) => {
      const mine = o.extraEventNames?.includes('agent.permission_request.changed') ?? false;
      useEffect(() => { if (!mine) return; live.perm += 1; return () => { live.perm -= 1; }; }, [mine]);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse('2026-10-03T14:00:00Z');

const perm = (id: string, over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id, request_id: `q-${id}`, setup_id: 's1', device_name: 'MacBook', agent_member_id: 'a1', agent_name: 'Dev', role: '개발', tool: 'Bash', summary: 'npm install', masked: false, truncated: false, workdir: '~/p',
  created_at: '2026-10-03T13:48:00Z', expires_at: '2026-10-03T14:30:00Z', state: 'pending', answered_by_name: null, decision: null, device_reachable: true, recipient_reason: 'paired', answerable: true,
  session_key: 's-1', input_hash: 'sha256:' + 'a'.repeat(64), ...over,
});
const lowGate = (id: string, title: string, over: Partial<GateItem> = {}): GateItem => ({
  id, org_id: 'org-1', work_item_id: `w-${id}`, work_item_type: 'story', gate_type: 'merge_gate', status: 'pending', resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
  created_at: '2026-10-03T13:00:00Z', updated_at: '2026-10-03T13:00:00Z', source: 'gate', requires_human: true, can_approve: true, risk_grade: 'low', work_item_summary: { title, slug: null }, ...over,
} as GateItem);

let container: HTMLDivElement;
let root: Root;
let permissionList: PermissionRequest[];
let gatesFail: boolean | 'held';
let pending: GateItem[];
let held: GateItem[];
let gateGets: string[];
let remoteOff = false;
let orgN = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  useDashboardContextMock.mockReturnValue({ orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩' }], projectMemberships: [], currentMemberType: 'human', currentTeamMemberId: 'member-1', projectId: 'proj-1', orgId: `org-${++orgN}` }); // a fresh org id per test (the remote-control value is kept per org)
  live.perm = 0; remoteOff = false; searchRef.current = ''; permissionList = []; pending = []; held = []; gatesFail = false; gateGets = [];
  fetchWithAuth.mockReset();
  // the permission list is the reader's own call; everything else (the approvals' two legs go through the same client) falls through to the stubbed global fetch below
  fetchWithAuth.mockImplementation(async (url: string, init?: unknown) => (url === '/api/agent-permission-requests'
    ? new Response(JSON.stringify({ requests: permissionList }), { status: 200 })
    : url.endsWith('/remote-control')
      ? new Response(JSON.stringify({ data: { enabled_at: null, enabled: !remoteOff, can_change: false, owner_names: ['송윤재'], connected_setups: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    : (globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init)));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/gates/inbox')) {
      gateGets.push(url);
      if (gatesFail === true || (gatesFail === 'held' && url.includes('status=held'))) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => (url.includes('status=held') ? held : pending) };
    }
    if (url.includes('/api/notifications')) return { ok: true, json: async () => ({ data: [], meta: { unreadCount: 0, hasMore: false, nextCursor: null } }) };
    if (url.includes('/api/workflow-executions')) return { ok: true, json: async () => ({ items: [] }) };
    return { ok: true, json: async () => [] };
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules();
});

// the provider is imported AFTER the module reset (the page and the provider must be the same module instance)
async function intl(node: React.ReactNode) {
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider>{node}</TopBarProvider></NextIntlClientProvider>;
}
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function mountQueue() {
  const { ApprovalsQueue } = await import('./approvals-queue');
  const tree = await intl(<ApprovalsQueue />);
  await act(async () => { root.render(tree); });
  await settle();
}
async function mountInboxGates() {
  searchRef.current = 'tab=gates';
  const { default: InboxPage } = await import('../../app/(authenticated)/inbox/page');
  const tree = await intl(<InboxPage />);
  await act(async () => { root.render(tree); });
  await settle();
}
const permReads = () => fetchWithAuth.mock.calls.filter((c) => c[0] === '/api/agent-permission-requests').length;
const rowsIn = (section: 'hand' | 'perm' | 'held') => [...container.querySelectorAll(`[data-testid="gate-queue-section-${section}"] [data-testid="gate-queue-row"]`)];
const detail = () => container.querySelector('[data-testid="gate-queue-detail"]');
const pickRow = async (key: string) => {
  const row = container.querySelector(`[data-testid="gate-queue-row"][data-row-key="${key}"]`);
  expect(row).toBeTruthy();
  await act(async () => { (row as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

describe('ApprovalsQueue — 4909 2d-2 the «에이전트 권한 요청» section', () => {
  it('⭐a section between «내 손이 필요해요» and «보류 중»: one row per request (kind chip · «에이전트 · 컴퓨터» · the tool · when it was asked), and the FIRST approval stays the picked row', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')]; held = [lowGate('g3', '보류된 항목', { status: 'held', held_until: null } as Partial<GateItem>)];
    permissionList = [perm('r1'), perm('r2', { agent_name: 'Writer', tool: 'Edit' })];
    await mountQueue();
    const order = [...container.querySelectorAll('section[data-testid^="gate-queue-section-"]')].map((s) => s.getAttribute('data-testid'));
    expect(order).toEqual(['gate-queue-section-hand', 'gate-queue-section-perm', 'gate-queue-section-held']);
    const rows = rowsIn('perm');
    expect(rows.map((r) => r.getAttribute('data-row-key'))).toEqual(['perm:r1', 'perm:r2']);
    expect(rows[0]!.textContent).toContain(koMessages.agentPermissions.chip);
    expect(rows[0]!.textContent).toContain('Dev · MacBook');
    expect(rows[0]!.textContent).toContain('Bash');
    expect(rows[1]!.textContent).toContain('Writer · MacBook');
    expect(container.querySelector('[data-testid="gate-queue-section-perm"]')?.getAttribute('aria-label')).toBe(koMessages.agentPermissions.groupTitle);
    // nothing picks a permission row while an approval exists: the detail is the first approval's card, not a permission card
    expect(detail()?.textContent).toContain('첫째 결재 항목');
    expect(container.querySelector('[data-testid="agent-permission-card"]')).toBeNull();
  });

  it('⭐with approvals only ON HOLD and a request, the first pick is the held approval — a request never comes before an approval (codex 2d-2 r1)', async () => {
    held = [lowGate('g3', '보류된 항목', { status: 'held', held_until: null } as Partial<GateItem>)];
    permissionList = [perm('r1')];
    await mountQueue();
    expect(rowsIn('held')).toHaveLength(1);
    expect(rowsIn('perm')).toHaveLength(1);
    expect(detail()?.textContent).toContain('보류된 항목');
    expect(container.querySelector('[data-testid="agent-permission-card"]')).toBeNull();
  });

  it('⭐the permission read answering BEFORE the approvals does not decide the first pick — the first approval is still the picked row', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')]; permissionList = [perm('r1')];
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const real = globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: unknown) => { if (u.startsWith('/api/gates/inbox')) await gate; return real(u, i); }));
    await mountQueue(); // the requests are read, the approvals are still on their way
    expect(container.querySelector('[data-testid="gate-queue-list"]')).toBeNull();
    release();
    await settle();
    expect(rowsIn('perm')).toHaveLength(1);
    expect(detail()?.textContent).toContain('첫째 결재 항목');
    expect(container.querySelector('[data-testid="agent-permission-card"]')).toBeNull();
  });

  it('⭐picking a permission row opens the same card the group drew (web: the one read-only line, no buttons); picking an approval brings its card back', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')];
    permissionList = [perm('r1')];
    await mountQueue();
    await pickRow('perm:r1');
    const card = detail()?.querySelector('[data-testid="agent-permission-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Dev · MacBook');
    expect(card!.textContent).toContain('npm install');
    expect(card!.querySelector('[data-testid="agent-permission-line"]')?.textContent).toBe(koMessages.agentPermissions.line.answerOnPhone);
    expect(card!.querySelector('[data-testid="agent-permission-buttons"]')).toBeNull(); // the phone app answers; the web only looks
    expect(detail()?.textContent).not.toContain('첫째 결재 항목');
    await pickRow('g1');
    expect(detail()?.querySelector('[data-testid="agent-permission-card"]')).toBeNull();
    expect(detail()?.textContent).toContain('첫째 결재 항목');
  });

  it('a permission row has no right-click menu of its own (the browser\'s menu stays — nothing to decide here)', async () => {
    permissionList = [perm('r1')];
    await mountQueue();
    const row = container.querySelector('[data-row-key="perm:r1"]') as HTMLElement;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => { row.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('⭐with no approvals at all, the requests are the list — no «nothing here» block over rows, and the first one is picked', async () => {
    permissionList = [perm('r1')];
    await mountQueue();
    expect(container.textContent).not.toContain(koMessages.cage.gateInboxEmpty);
    expect(rowsIn('perm')).toHaveLength(1);
    expect(detail()?.querySelector('[data-testid="agent-permission-card"]')).toBeTruthy();
  });

  it('with no request either, the screen is the «nothing here» block as before', async () => {
    await mountQueue();
    expect(container.textContent).toContain(koMessages.cage.gateInboxEmpty);
    expect(container.querySelector('[data-testid="gate-queue-section-perm"]')).toBeNull();
  });

  it('⭐when the approvals could not be read, the requests are still listed with the error block above them (the old group never depended on the approvals); with none, the error stands alone', async () => {
    gatesFail = true; permissionList = [perm('r1')];
    await mountQueue();
    const errBlock = container.querySelector('[data-testid="gate-inbox-load-error"]');
    expect(errBlock).not.toBeNull();
    expect(rowsIn('perm')).toHaveLength(1);
    // the error block sits ABOVE the list (document order), not under it
    expect(errBlock!.compareDocumentPosition(container.querySelector('[data-testid="gate-queue-list"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { root.unmount(); });
    root = createRoot(container); permissionList = [];
    await mountQueue();
    expect(container.querySelector('[data-testid="gate-inbox-load-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gate-queue-list"]')).toBeNull();
  });

  it('⭐when ONE approvals leg fails and the other answers, the partial approvals are NOT drawn (the old screen hid them behind the error) — the error block and the requests only (codex 2d-2 r2)', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')]; gatesFail = 'held'; permissionList = [perm('r1')];
    await mountQueue();
    expect(container.querySelector('[data-testid="gate-inbox-load-error"]')).not.toBeNull();
    expect(container.textContent).not.toContain('첫째 결재 항목');
    expect(rowsIn('hand')).toHaveLength(0);
    expect(rowsIn('perm')).toHaveLength(1);
    expect(detail()?.querySelector('[data-testid="agent-permission-card"]')).toBeTruthy(); // the request is the picked row, never an approval of the partial list
  });

  it('a request that arrives on a later read joins the section without taking the picked row from the person', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')];
    await mountQueue();
    expect(rowsIn('perm')).toHaveLength(0);
    permissionList = [perm('r1')];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); // nothing shown → the slower clock
    await settle();
    expect(rowsIn('perm')).toHaveLength(1);
    expect(detail()?.textContent).toContain('첫째 결재 항목');
    expect(container.querySelector('[data-testid="agent-permission-card"]')).toBeNull();
  });

  it('the picked request leaving the list (answered elsewhere · withdrawn) moves the detail to the next row of the list, never leaves it empty', async () => {
    permissionList = [perm('r1'), perm('r2', { agent_name: 'Writer' })];
    await mountQueue();
    await pickRow('perm:r1');
    permissionList = [perm('r2', { agent_name: 'Writer' })];
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();
    expect(rowsIn('perm').map((r) => r.getAttribute('data-row-key'))).toEqual(['perm:r2']);
    expect(detail()?.querySelector('[data-testid="agent-permission-card"]')?.textContent).toContain('Writer · MacBook');
  });
});

describe('ApprovalsQueue — 4909 2d-2 the «remote control is off» line stays on the screen', () => {
  const offLine = () => container.querySelector('[data-testid="agent-permission-remote-off"]');
  it('⭐it sits above the list (the old group drew it above its rows) — with approvals, with none, and not at all while remote control is on', async () => {
    remoteOff = true; pending = [lowGate('g1', '첫째 결재 항목')];
    await mountQueue();
    expect(offLine()?.textContent).toContain('송윤재');
    const list = container.querySelector('[data-testid="gate-queue-list"]');
    expect(list).not.toBeNull();
    expect(offLine()!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the list, not under it
    await act(async () => { root.unmount(); });
    root = createRoot(container); pending = [];
    useDashboardContextMock.mockReturnValue({ ...useDashboardContextMock(), orgId: `org-${++orgN}` });
    await mountQueue();
    expect(offLine()).not.toBeNull(); // the screen is the «nothing here» block, the line still says why none come
    expect(container.textContent).toContain(koMessages.cage.gateInboxEmpty);
    await act(async () => { root.unmount(); });
    root = createRoot(container); remoteOff = false;
    useDashboardContextMock.mockReturnValue({ ...useDashboardContextMock(), orgId: `org-${++orgN}` });
    await mountQueue();
    expect(offLine()).toBeNull();
  });
});

describe('ApprovalsQueue — 4909 defect PR: the FRAME gives the detail column its height (no «100svh − 6rem» guess)', () => {
  it('⭐the inbox 결재함 tab body is a column of definite height, the screen takes what is left of it, and the detail block fills its column — no viewport-height calc anywhere on the path', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')];
    await mountInboxGates();
    const screen = container.querySelector('[data-testid="gates-screen"]') as HTMLElement;
    const body = screen.parentElement as HTMLElement; // the tab body the page draws
    expect(body.className).toContain('flex min-h-0 flex-1 flex-col');
    expect(body.className).toContain('lg:overflow-hidden'); // wide: nothing scrolls but the two columns; narrow keeps the one scrolling page (overflow-y-auto)
    expect(body.className).toContain('overflow-y-auto');
    expect(screen.className).toContain('lg:flex-1');
    expect(screen.className).toContain('lg:grid-rows-[minmax(0,1fr)]');
    const column = container.querySelector('[data-testid="gates-screen-detail-column"]') as HTMLElement;
    expect(column.className).toContain('lg:h-full');
    expect(detail()!.className).toContain('lg:h-full');
    expect(detail()!.className).toContain('lg:overflow-y-auto');
    expect(container.querySelector('[data-testid="gate-queue-list"]')!.className).toContain('lg:max-h-full');
    for (const el of [body, screen, column, detail()!, container.querySelector('[data-testid="gate-queue-list"]')!]) expect(el.className).not.toMatch(/svh|calc\(|sticky/);
  });
});

describe('ApprovalsQueue — 4909 2d-2 ONE reader on the screen', () => {
  it('⭐the list alone: the approvals\' two legs, ONE read of the permission list, ONE subscription to the named frame, ONE 15 s clock (1 → 2 reads after 15 s)', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')]; permissionList = [perm('r1')];
    await mountQueue();
    expect(gateGets.filter((u) => u.includes('status=pending'))).toHaveLength(1);
    expect(gateGets.filter((u) => u.includes('status=held'))).toHaveLength(1);
    expect(permReads()).toBe(1);
    expect(live.perm).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();
    expect(permReads()).toBe(2);
    expect(live.perm).toBe(1);
  });

  it('⭐the whole inbox «결재함» tab (the page, not just the list): still ONE read, ONE subscription, ONE clock — the old block above the list is gone', async () => {
    pending = [lowGate('g1', '첫째 결재 항목')]; permissionList = [perm('r1')];
    await mountInboxGates();
    expect(container.querySelector('[data-testid="agent-permission-requests"]')).toBeNull(); // the standalone group is not drawn
    expect(rowsIn('perm')).toHaveLength(1);
    expect(permReads()).toBe(1);
    expect(live.perm).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await settle();
    expect(permReads()).toBe(2);
  });

  it('unmounting the screen ends its subscription (nothing keeps listening)', async () => {
    permissionList = [perm('r1')];
    await mountQueue();
    expect(live.perm).toBe(1);
    await act(async () => { root.unmount(); });
    expect(live.perm).toBe(0);
    root = createRoot(container);
  });
});
