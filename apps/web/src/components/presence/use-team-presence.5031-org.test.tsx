// @vitest-environment jsdom
//
// story 5031 (the top bar's «일하는 중» badge) — after the person switches ORGANIZATION the badge kept the old organization's number until a reload.
// The ask `/api/team-presence` carries no organization in its URL (the organization rides on the session — the fetch interceptor's X-Org-Id) and the hook's effect did not list the organization,
// while the shell that holds the hook is NOT remounted by a switch (the bar is outside the page body's key). What is pinned here: ① the organization changes → the old number is gone at once · one more ask ·
// the new organization's answer; ② an ask of the OLD organization still in flight does not swallow the new ask (the in-flight guard) and its late answer never lands; ③ the same organization → no extra ask;
// ④ an organization first known LATE is not a switch (the number is kept). The context is a prop: the tests change it and render again (there is no two-organization account here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RealtimeProvider } from '@/components/realtime-provider';
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

/** the server answers for the organization the SESSION is in at the moment the ask LEAVES (a held ask keeps its organization's rows); `hold` makes the asks of that organization wait for `release()` */
const server = { org: ORG_A as string, hold: null as string | null, gates: [] as Array<() => void> };
const release = () => { const g = server.gates.splice(0); g.forEach((f) => f()); };
function stubServer() {
  const fetchMock = vi.fn(async (url: string) => {
    if (!String(url).startsWith('/api/team-presence')) return { ok: false, status: 404, json: async () => null };
    const asked = server.org;
    if (server.hold === asked) await new Promise<void>((resolve) => { server.gates.push(resolve); });
    return { ok: true, json: async () => ({ data: ROWS[asked] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const asks = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/team-presence'));

function Badge({ orgId }: { orgId?: string }) {
  const items = useTeamPresence(true, orgId);
  return <span data-testid="count">{items.filter((i) => i.working).length}</span>;
}
const count = () => container.querySelector('[data-testid="count"]')?.textContent;
async function show(orgId?: string) {
  await act(async () => { root.render(<RealtimeProvider currentTeamMemberId="m1"><Badge orgId={orgId} /></RealtimeProvider>); });
}
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  server.org = ORG_A; server.hold = null; server.gates = [];
});
afterEach(async () => {
  release();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('useTeamPresence — 조직을 바꾸면 다시 묻는다(story 5031)', () => {
  it('⭐① 조직 A→B: 옛 숫자(3)가 그 즉시 사라지고 · 다시 묻고 · B의 숫자(2)가 뜬다', async () => {
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    expect(count()).toBe('3');
    expect(asks(fetchMock)).toHaveLength(1);
    server.org = ORG_B; server.hold = ORG_B; // the session is in B now; B's answer is held — what does the badge show meanwhile?
    await show(ORG_B);
    expect(count(), 'the old organization number is not shown while the new answer is on its way (reverted → still 3)').toBe('0');
    expect(asks(fetchMock), 'asked again (reverted → still one)').toHaveLength(2);
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(count()).toBe('2');
  });

  it('⭐② 옛 조직(A)의 물음이 아직 진행 중일 때 조직이 바뀌어도 새 물음이 «이미 진행 중» 가드에 삼켜지지 않는다 · 늦게 돌아온 A의 답은 B의 숫자를 덮지 않는다', async () => {
    server.hold = ORG_A; // A's FIRST ask hangs
    const fetchMock = stubServer();
    await show(ORG_A); await settle();
    expect(asks(fetchMock)).toHaveLength(1);
    expect(count()).toBe('0');
    server.org = ORG_B; server.hold = null; // B answers at once
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
    expect(count()).toBe('3'); // the first ask went out under the session's organization (A)
    server.hold = ORG_A; // the next ask is held, so a cleared number would show as 0
    await show(ORG_A);
    expect(count(), 'a late first look is recorded, not a switch (reverted → 0)').toBe('3');
    expect(asks(fetchMock).length).toBeGreaterThanOrEqual(1);
  });
});
