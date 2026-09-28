// story #4263(PO 14:57Z ①) — 공용 요청 합류의 경합: 이벤트가 부른 재조회가 **이벤트 전에 뜬 요청**에 합류하면 이벤트 전 스냅숏을 받아 다음 계기까지
// 낡은 수가 남는다. 이벤트 재조회(fresh)는 새로 묻고, 늦게 온 옛 응답은 새 값을 덮지 않는다(마지막 요청 값). 두 공용 클라이언트 모두.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string) => (globalThis.fetch as unknown as (u: string) => Promise<Response>)(url) }));
vi.mock('@/lib/project-context-client', () => ({ getRequestContextKey: () => 'org-1|proj-1' }));

type Pending = { resolve: (count: number) => void };
let pending: Pending[] = [];

beforeEach(() => {
  pending = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
    pending.push({ resolve: (count: number) => resolve({ ok: true, status: 200, json: async () => ({ count }) }) });
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const tick = () => new Promise((r) => setTimeout(r, 0));

describe.each([
  ['unread-count', async () => {
    const m = await import('./chat-unread-total-client');
    m.resetChatUnreadTotalStateForTest();
    return (fresh?: boolean) => m.fetchChatUnreadTotal(fresh ? { fresh: true } : undefined);
  }],
  ['designated-pending-count', async () => {
    const m = await import('./designated-pending-count-client');
    m.resetDesignatedPendingCountStateForTest();
    return (fresh?: boolean) => m.fetchDesignatedPendingCount(fresh ? { fresh: true } : undefined);
  }],
])('%s — 이벤트 재조회는 앞선 요청에 합류하지 않는다 · 마지막 요청 값만(#4263 ①)', (_name, load) => {
  it('⭐A 진행 중 이벤트 → B가 새로 나감 · 최종 값 = B · A가 늦게 와도 B를 안 덮음 · 뒤 합류자는 B', async () => {
    const get = await load();
    const a = get(); // 기동 · 포커스(t0)
    await tick();
    const b = get(true); // 이벤트(conversation.read · gate_resolved)
    await tick();
    expect(pending).toHaveLength(2); // 합류하지 않고 새로 물었다
    const joiner = get(); // 이벤트 뒤 같은 계기 호출 — B에 합류
    await tick();
    expect(pending).toHaveLength(2);

    pending[1]!.resolve(5); // B(이벤트 뒤 스냅숏)
    await expect(b).resolves.toBe(5);
    await expect(joiner).resolves.toBe(5);
    pending[0]!.resolve(3); // A(이벤트 전 스냅숏)가 늦게 도착
    await expect(a).resolves.toBe(5); // 옛 응답이 새 값을 덮지 않는다
  });

  it('같은 계기(기동 · 포커스)끼리는 여전히 합류 — 요청 1', async () => {
    const get = await load();
    const x = get();
    const y = get();
    await tick();
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(2);
    await expect(x).resolves.toBe(2);
    await expect(y).resolves.toBe(2);
  });
});

describe('subscribeDesignatedPendingCount — 게이트 이벤트 재조회는 진행 중 요청에 합류하지 않는다(#4263 ①)', () => {
  it('⭐기동 요청 진행 중 gate_resolved → 새 요청 · 콜백은 새 값', async () => {
    const m = await import('./designated-pending-count-client');
    m.resetDesignatedPendingCountStateForTest();
    const handlers: Record<string, (d: string) => void> = {};
    const seen: number[] = [];
    m.subscribeDesignatedPendingCount({ subscribe: (n, h) => { handlers[n] = h; return () => {}; } }, (c) => seen.push(c));
    const boot = m.fetchDesignatedPendingCount();
    await tick();
    handlers['conversation.gate_resolved']!(JSON.stringify({ gate_id: 'g-1' }));
    await tick();
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(1);
    pending[0]!.resolve(2);
    await boot;
    await tick();
    expect(seen).toEqual([1]);
  });
});

// story #4263(PO 14:57Z ② · 4247 AC2) — 사이드바 · 탭바가 둘 다 마운트돼 같은 게이트 이벤트를 받아도 이벤트당 요청 1(같은 디스패치 안 fresh끼리 합류).
describe('같은 이벤트의 구독자 둘 → 요청 1 · 다음 이벤트는 새 요청', () => {
  it('⭐사이드바 · 탭바 구독 둘 · gate_resolved 1건 → 요청 1 · 두 콜백 모두 새 값', async () => {
    const m = await import('./designated-pending-count-client');
    m.resetDesignatedPendingCountStateForTest();
    const subs: Array<(d: string) => void> = [];
    const mux = { subscribe: (n: string, h: (d: string) => void) => { if (n === 'conversation.gate_resolved') subs.push(h); return () => {}; } };
    const sidebar: number[] = []; const tabbar: number[] = [];
    m.subscribeDesignatedPendingCount(mux, (c) => sidebar.push(c));
    m.subscribeDesignatedPendingCount(mux, (c) => tabbar.push(c));
    for (const h of subs) h(JSON.stringify({ gate_id: 'g-1' })); // mux 디스패치 = 한 동기 루프
    await tick();
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(3);
    await tick(); await tick();
    expect(sidebar).toEqual([3]);
    expect(tabbar).toEqual([3]);
    for (const h of subs) h(JSON.stringify({ gate_id: 'g-2' })); // 다음 이벤트
    await tick();
    expect(pending).toHaveLength(2);
  });
});

it('⭐unread-count — 같은 conversation.read를 받은 훅 여러 마운트(한 동기 디스패치의 fresh 둘) → 요청 1 · 다음 이벤트는 새 요청', async () => {
  const m = await import('./chat-unread-total-client');
  m.resetChatUnreadTotalStateForTest();
  const x = m.fetchChatUnreadTotal({ fresh: true });
  const y = m.fetchChatUnreadTotal({ fresh: true });
  await tick();
  expect(pending).toHaveLength(1);
  pending[0]!.resolve(7);
  await expect(x).resolves.toBe(7);
  await expect(y).resolves.toBe(7);
  void m.fetchChatUnreadTotal({ fresh: true });
  await tick();
  expect(pending).toHaveLength(2);
});

// 까디르 codex 4626 P2 — 워터마크도 최신 요청의 응답만. 옛 응답이 늦게 워터마크를 들고 와도 쓰지 않고, 최신 응답이 실패하거나 워터마크가
// 없으면 이전 워터마크를 무효화 → 뒤 백필 이벤트는 «이미 반영»으로 건너뛰지 않는다(다시 묻는다).
describe('designated-pending-count 워터마크 — 최신 요청 응답만 · 실패/없음이면 무효화', () => {
  type Ctl = { ok: (count: number, xmin?: string) => void; fail: () => void };
  let ctls: Ctl[] = [];
  beforeEach(() => {
    ctls = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      ctls.push({
        ok: (count: number, xmin?: string) => resolve({ ok: true, status: 200, json: async () => ({ count, ...(xmin ? { snapshot_xmin: xmin } : {}) }) }),
        fail: () => resolve({ ok: false, status: 500, json: async () => ({}) }),
      });
    })));
  });
  const backfill = (xid: string) => JSON.stringify({ is_backfill: true, created_xid: xid });

  it('⭐A 진행 중 B 발사 → A가 늦게 워터마크(100) · B 실패 → 백필(created_xid 50)은 건너뛰지 않는다', async () => {
    const m = await import('./designated-pending-count-client');
    m.resetDesignatedPendingCountStateForTest();
    const a = m.fetchDesignatedPendingCount();
    await tick();
    const b = m.fetchDesignatedPendingCount({ fresh: true });
    await tick();
    ctls[1]!.fail();
    await b;
    ctls[0]!.ok(3, '100'); // 옛 응답이 늦게 워터마크를 들고 옴
    await a;
    await tick();
    expect(m.isEventReflectedInLastCount(backfill('50'))).toBe(false);
  });

  it('⭐최신 요청이 실패하면 이전 워터마크 무효화(워터마크 100 뒤 새 요청 500 → 백필 50은 다시 묻는다)', async () => {
    const m = await import('./designated-pending-count-client');
    m.resetDesignatedPendingCountStateForTest();
    const first = m.fetchDesignatedPendingCount();
    await tick();
    ctls[0]!.ok(2, '100');
    await first;
    expect(m.isEventReflectedInLastCount(backfill('50'))).toBe(true);
    const second = m.fetchDesignatedPendingCount({ fresh: true });
    await tick();
    ctls[1]!.fail();
    await second;
    expect(m.isEventReflectedInLastCount(backfill('50'))).toBe(false);
  });

  it('최신 응답에 워터마크가 없으면 이전 워터마크 무효화', async () => {
    const m = await import('./designated-pending-count-client');
    m.resetDesignatedPendingCountStateForTest();
    const first = m.fetchDesignatedPendingCount();
    await tick();
    ctls[0]!.ok(2, '100');
    await first;
    expect(m.isEventReflectedInLastCount(backfill('50'))).toBe(true); // 대조: 워터마크 있음 → 건너뜀
    const second = m.fetchDesignatedPendingCount({ fresh: true });
    await tick();
    ctls[1]!.ok(2); // 워터마크 없음
    await second;
    expect(m.isEventReflectedInLastCount(backfill('50'))).toBe(false);
  });
});
