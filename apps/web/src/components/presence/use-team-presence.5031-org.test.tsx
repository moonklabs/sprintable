// @vitest-environment jsdom
//
// story 5031 (the top bar's «일하는 중» badge) — after the person switches ORGANIZATION the badge kept the old organization's number until a reload.
// The ask `/api/team-presence` carries no organization in its URL (the organization rides on the session — the fetch interceptor's X-Org-Id) and the hook's effect did not list the organization,
// while the shell that holds the hook is NOT remounted by a switch (the bar is outside the page body's key). What is pinned here: ① the organization changes → the old number is gone at once · one more ask ·
// the new organization's answer; ② an ask of the OLD organization still in flight does not swallow the new ask (the in-flight guard) and its late answer never lands; ③ the same organization → no extra ask;
// ④ an organization first known LATE is not a switch (the number is kept). The context is a prop: the tests change it and render again (there is no two-organization account here).
// THE SERVER HERE ANSWERS FROM THE `X-Org-Id` THE REQUEST ACTUALLY CARRIES (codex round 2: a mock that ignored the request could not tell a wrong header binding): the REAL header interceptor is installed on top of a delegating fetch,
// and `show()` sets the effective organization the way the shell does in its render (`setEffectiveOrgId`, before any child effect). What is still ASSUMED, not measured here: that the shell really calls `setEffectiveOrgId` before the hook's
// effect and hands the same value to the hook — `dashboard-shell-org-key.5031.test.tsx` pins the shell side (the hook receives the shell's organization, and the real first request after a switch carries the new header).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RealtimeProvider } from '@/components/realtime-provider';
import { installProjectHeaderInterceptor, setEffectiveOrgId, setEffectiveProjectId } from '@/lib/project-context-client';
import { useTeamPresence } from './use-team-presence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const ORG_A = 'org-5031-presence-a';
const ORG_B = 'org-5031-presence-b';
const member = (id: string, working: boolean) => ({ member_id: id, name: id, working });
// organization A has THREE agents working, organization B has TWO — the badge number tells which organization an answer belonged to
const ROWS: Record<string, ReturnType<typeof member>[]> = {
  [ORG_A]: [member('a1', true), member('a2', true), member('a3', true), member('a4', false)],
  [ORG_B]: [member('b1', true), member('b2', true), member('b3', false)],
};

/** the server answers for the organization the REQUEST carries in `X-Org-Id` (no header = the session's own organization, A here); a held ask keeps its organization's rows; `hold` makes the asks of that organization wait for `release()` */
const server = { hold: new Set<string>(), gates: [] as Array<{ org: string; open: () => void }> };
/** opens the held asks — of one organization, or of all of them */
const release = (org?: string) => {
  const open = server.gates.filter((g) => !org || g.org === org);
  server.gates = server.gates.filter((g) => !open.includes(g));
  open.forEach((g) => g.open());
};
/** what went out: the URL and the organization header the ask really carried */
let sent: Array<{ url: string; org: string | undefined }> = [];
let handler: (input: string, init?: RequestInit) => Promise<unknown> = async () => ({ ok: false, status: 404, json: async () => null });
// the real header interceptor wraps THIS fetch once; each test only swaps the handler behind it
beforeAll(() => {
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
  installProjectHeaderInterceptor();
});
function stubServer() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('/api/team-presence')) return { ok: false, status: 404, json: async () => null };
    const org = new Headers(init?.headers).get('X-Org-Id') ?? undefined;
    sent.push({ url: String(url), org });
    const asked = org ?? ORG_A;
    if (server.hold.has(asked)) await new Promise<void>((resolve) => { server.gates.push({ org: asked, open: resolve }); });
    return { ok: true, json: async () => ({ data: ROWS[asked] }) };
  });
  handler = fetchMock as unknown as typeof handler;
  return fetchMock;
}
const asks = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/team-presence'));

function Badge({ orgId }: { orgId?: string }) {
  const items = useTeamPresence(true, orgId);
  return <span data-testid="count">{items.filter((i) => i.working).length}</span>;
}
const count = () => container.querySelector('[data-testid="count"]')?.textContent;
async function show(orgId?: string) {
  // what the shell does in its render, before any child effect (read, not run here — see the header). The interceptor puts `X-Org-Id` on a request ONLY TOGETHER WITH a project (`project-context-client.ts`: `if (isApi && projectId)`),
  // so the shell's pair is set here too — a test that set only the organization carried no header at all and every ask was answered as A (found the hard way).
  setEffectiveOrgId(orgId);
  setEffectiveProjectId(orgId ? `proj-of-${orgId}` : undefined);
  await act(async () => { root.render(<RealtimeProvider currentTeamMemberId="m1"><Badge orgId={orgId} /></RealtimeProvider>); });
}
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  server.hold = new Set(); server.gates = []; sent = [];
  setEffectiveOrgId(undefined);
  setEffectiveProjectId(undefined);
});
afterEach(async () => {
  release();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'hidden'); // back to the environment's own value
});
/** the tab is hidden / shown (the hook asks nothing while hidden and catches up when it is shown again) */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}
const visibilityChange = () => act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

describe('useTeamPresence — 조직을 바꾸면 다시 묻는다(story 5031)', () => {
  it('⭐① 조직 A→B: 옛 숫자(3)가 그 즉시 사라지고 · 다시 묻고 · B의 숫자(2)가 뜬다', async () => {
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    expect(count()).toBe('3');
    expect(asks(fetchMock)).toHaveLength(1);
    server.hold = new Set([ORG_B]); // B's answer is held — what does the badge show meanwhile?
    await show(ORG_B);
    expect(count(), 'the old organization number is not shown while the new answer is on its way (reverted → still 3)').toBe('0');
    expect(asks(fetchMock), 'asked again (reverted → still one)').toHaveLength(2);
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(count()).toBe('2');
    // the header binding (codex round 2): the first ask carried A's organization header (`show(ORG_A)` set it, as the shell does), the second carried B's
    expect(sent.map((s) => s.org), 'each ask carries the organization the shell had set when it left').toEqual([ORG_A, ORG_B]);
  });

  it('⭐② 옛 조직(A)의 물음이 아직 진행 중일 때 조직이 바뀌어도 새 물음이 «이미 진행 중» 가드에 삼켜지지 않는다 · 늦게 돌아온 A의 답은 B의 숫자를 덮지 않는다', async () => {
    server.hold = new Set([ORG_A]); // A's FIRST ask hangs
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    expect(asks(fetchMock)).toHaveLength(1);
    expect(count()).toBe('0');
    server.hold = new Set(); // B answers at once
    await show(ORG_B); await settle();
    expect(asks(fetchMock), 'the new ask went out although the old one is still in flight (reverted → the guard swallowed it: one)').toHaveLength(2);
    expect(count()).toBe('2');
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); // …now A's answer (three working) arrives
    await settle();
    expect(count(), 'A\'s late answer never lands on B').toBe('2');
  });

  it('③ 같은 조직으로 다시 그려도(다른 값이 바뀜) 다시 묻지 않는다', async () => {
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    await show(ORG_A); await settle();
    await show(ORG_A); await settle();
    expect(asks(fetchMock)).toHaveLength(1);
    expect(count()).toBe('3');
  });

  it('④ 조직을 늦게 알게 되는 경우(마운트 때 비어 있던 조직)는 «전환»이 아니다 — 이미 받은 숫자를 비우지 않는다', async () => {
    const fetchMock = stubServer();
    await show(undefined); await settle();
    // the first ask carried no organization header (none was known yet): the server took it for the session's own organization (A) — that is what the number 3 stands for. The real shell does set the effective organization before the child effect (read in
    // `dashboard-shell.tsx`, and pinned from the shell side in `dashboard-shell-org-key.5031.test.tsx`), so a late-known organization is the SAME organization the first ask already ran under — that is the reading «keep the number» rests on.
    expect(sent[0]?.org).toBeUndefined();
    expect(count()).toBe('3');
    server.hold = new Set([ORG_A]); // the next ask is held, so a cleared number would show as 0
    await show(ORG_A);
    expect(count(), 'a late first look is recorded, not a switch (reverted → 0)').toBe('3');
    expect(asks(fetchMock).length).toBeGreaterThanOrEqual(1);
  });

  // codex round 1 on 28e77099: the in-flight mark and the sequence number were shared by asks of different organizations.
  it('⭐⑤ B의 물음이 진행 중일 때 옛 A의 물음이 끝나도 B의 «진행 중» 표지를 지우지 않는다 — 세 번째 물음이 나가지 않고 B의 답이 숫자가 된다', async () => {
    server.hold = new Set([ORG_A, ORG_B]); // both organizations' asks hang until released one by one
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    expect(asks(fetchMock)).toHaveLength(1); // A in flight
    await show(ORG_B); await settle();
    expect(asks(fetchMock), 'B asked although A is in flight').toHaveLength(2);
    await visibilityChange(); // a trigger while B is in flight → «ask once more when it ends», nothing goes out now
    expect(asks(fetchMock)).toHaveLength(2);
    await act(async () => { release(ORG_A); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); // A ends first
    await settle();
    expect(asks(fetchMock), 'A\'s end must not clear B\'s in-flight mark and start a third ask while B runs (reverted → three)').toHaveLength(2);
    expect(count(), 'A\'s answer is dropped').toBe('0');
    await act(async () => { release(ORG_B); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    expect(count(), 'B\'s valid answer lands (reverted → rejected by the sequence guard: 0)').toBe('2');
  });

  it('⭐⑥ 탭이 숨겨진 채 조직이 바뀌어도(그동안 새 물음이 안 나간다) 옛 A의 늦은 답이 A의 숫자를 되살리지 않는다', async () => {
    server.hold = new Set([ORG_A]); // A's ask is in flight
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    expect(asks(fetchMock)).toHaveLength(1);
    setHidden(true); // the tab is hidden: no ask is started now
    server.hold = new Set();
    await show(ORG_B); await settle();
    expect(asks(fetchMock), 'nothing asked while hidden').toHaveLength(1);
    await act(async () => { release(ORG_A); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    expect(count(), 'A\'s late answer never repopulates the old organization\'s number (reverted → 3)').toBe('0');
    setHidden(false);
    await visibilityChange(); // shown again → B asks
    await settle();
    expect(asks(fetchMock)).toHaveLength(2);
    expect(count()).toBe('2');
  });
});
