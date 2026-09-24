// @vitest-environment jsdom
// story #4245 — 사이드바 «결재» 배지 수(designated-pending-count)는 마운트 때 한 번 묻고, 이후엔 결재가 바뀌는 실시간 이벤트에만 다시 묻는다.
// SSE 연결 직후 서버가 다시 보내는 백필(is_backfill: true) 중 **마지막 수에 이미 보였던** 것 — 만든 트랜잭션(created_xid)이 수를 센 순간의
// 스냅숏 워터마크(snapshot_xmin)보다 작은 것 — 은 다시 묻지 않는다(dev 배포 21 · 기동마다 두 번째 요청이 이 자리에서 나갔다).
// 그때 아직 안 끝난 트랜잭션의 이벤트(까디르 QA P2 — 시각 판정으론 놓치던 자리) · 옛 행 · 모르는 경우는 다시 묻는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { handlers, mux } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(data: string, id?: string) => void>>();
  const mux = {
    subscribe: (name: string, fn: (data: string, id?: string) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return () => { handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn)); };
    },
    subscribeMessage: () => () => {},
    subscribeReconnect: () => () => {},
    connected: true,
  };
  return { handlers, mux };
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => mux,
  useSseConnectedContext: () => true,
}));

const { AppSidebar } = await import('./app-sidebar');
const { resetDesignatedPendingCountStateForTest } = await import('@/lib/designated-pending-count-client');
let xmin = '1000';
const { SidebarProvider } = await import('@/components/ui/sidebar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  xmin = '1000';
  resetDesignatedPendingCountStateForTest();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  fetchMock = vi.fn(async (url: string) => new Response(
    JSON.stringify(String(url).includes('designated-pending-count') ? { count: 2, snapshot_xmin: xmin } : { data: {} }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const countCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('designated-pending-count')).length;
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
function fire(name: string, data: unknown) {
  for (const h of handlers.get(name) ?? []) h(JSON.stringify(data));
}

describe('AppSidebar — 결재 배지 수 재조회는 이미 반영된 백필 이벤트에 반응하지 않는다(story #4245)', () => {
  async function mountSidebar() {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SidebarProvider>
        <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />
      </SidebarProvider></NextIntlClientProvider>);
    });
    await flush();
  }
  const backfill = (gate_id: string, created_xid?: string) => ({ gate_id, is_backfill: true, created_at: '2026-09-24T03:18:16Z', ...(created_xid ? { created_xid } : {}) });

  it('⭐마운트 1번 · 수를 센 순간 이미 끝난 트랜잭션의 백필(created_xid < snapshot_xmin) 뒤에도 1번 · 실시간 이벤트면 2번', async () => {
    await mountSidebar();
    expect(countCalls()).toBe(1);
    await act(async () => {
      fire('conversation.gate_resolved', backfill('g1', '900'));
      fire('conversation.gate_delegated', backfill('g2', '999'));
      fire('conversation.gate_tossed', backfill('g3', '1'));
    });
    await flush();
    expect(countCalls()).toBe(1);
    await act(async () => { fire('conversation.gate_resolved', { gate_id: 'g4', created_xid: '900' }); });
    await flush();
    expect(countCalls()).toBe(2);
  });

  it('⭐까디르 시나리오 — 수를 센 순간 아직 안 끝난 트랜잭션(이벤트는 그 전에 남김 · 커밋은 뒤)의 백필은 다시 묻는다', async () => {
    // 해소 트랜잭션 xid 995가 이벤트를 남기고 외부 호출을 기다리는 동안 수를 셈 → 워터마크 990(995가 아직 진행 중). 커밋 뒤 재연결 백필로 옴.
    xmin = '990';
    await mountSidebar();
    expect(countCalls()).toBe(1);
    await act(async () => { fire('conversation.gate_resolved', backfill('g5', '995')); });
    await flush();
    expect(countCalls()).toBe(2);
  });

  it('⭐경계 — created_xid == snapshot_xmin(그 순간 가장 오래된 진행 중 트랜잭션)은 다시 묻는다', async () => {
    await mountSidebar();
    await act(async () => { fire('conversation.gate_resolved', backfill('g6', '1000')); });
    await flush();
    expect(countCalls()).toBe(2);
  });

  it('64비트 xid(2^53 넘음)도 정밀도 손실 없이 비교한다 — number로 풀면 같아지는 두 값', async () => {
    // 2^54 근처는 double 간격이 4 — 18014398509481985와 …986은 number로는 같은 값(2^54)이 된다.
    xmin = '18014398509481986';
    await mountSidebar();
    await act(async () => { fire('conversation.gate_resolved', backfill('g7', '18014398509481985')); });
    await flush();
    expect(countCalls()).toBe(1);
    await act(async () => { fire('conversation.gate_resolved', backfill('g8', '18014398509481986')); });
    await flush();
    expect(countCalls()).toBe(2);
  });

  it('⭐org 전환 뒤(요청 맥락이 바뀜) 새 맥락의 수를 받기 전엔 옛 워터마크로 건너뛰지 않는다 — 다시 묻는다', async () => {
    const { setEffectiveOrgId } = await import('@/lib/project-context-client');
    try {
      await mountSidebar();
      expect(countCalls()).toBe(1);
      setEffectiveOrgId('org-B');
      await act(async () => { fire('conversation.gate_resolved', backfill('g9', '900')); });
      await flush();
      expect(countCalls()).toBe(2);
    } finally {
      setEffectiveOrgId(undefined);
    }
  });

  it('created_xid 없는 백필(마이그레이션 전 옛 행)은 다시 묻는다', async () => {
    await mountSidebar();
    await act(async () => { fire('conversation.gate_resolved', backfill('g10')); });
    await flush();
    expect(countCalls()).toBe(2);
  });
});
