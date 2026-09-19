// @vitest-environment jsdom
//
// story #4063 후속(PR 9dd179582 위) — use-hook-performances.test.tsx와 동일 하네스.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMaterialPerformances } from './use-material-performances';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

function Harness({ derivedIds }: { derivedIds: string[] }) {
  const { snapshotsByDerivedId, loading, loadFailed } = useMaterialPerformances(derivedIds);
  return <div data-testid="dump">{JSON.stringify({ keys: Object.keys(snapshotsByDerivedId), counts: Object.values(snapshotsByDerivedId).map((s) => s.length), loading, loadFailed })}</div>;
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

const SNAPSHOT = () => ({ id: 's1', channel: 'instagram', due_at: '2026-09-01T00:00:00Z', captured_at: '2026-09-01T00:00:00Z', status: 'captured', normalized: { views: 10 }, source: 'organic', error_code: null, offset_label: 'd1' });

describe('useMaterialPerformances — derivedIds만큼 병렬 GET .../material-performance?derived_id=', () => {
  it('각 derivedId를 개별 쿼리로 호출하고 맵으로 모은다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const id = new URL(url, 'http://x').searchParams.get('derived_id')!;
      return { ok: true, json: async () => (id === 'd1' ? [SNAPSHOT()] : []) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness derivedIds={['d1', 'd2']} />); });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dump()).toEqual({ keys: ['d1', 'd2'], counts: [1, 0], loading: false, loadFailed: false });
  });

  it('draft(미발행) 등 빈 배열 응답은 실패가 아니라 그 키에 빈 배열로 정직하게 남는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));

    await act(async () => { root.render(<Harness derivedIds={['draft-1']} />); });
    await flush();

    const state = dump();
    expect(state.keys).toEqual(['draft-1']);
    expect(state.counts).toEqual([0]);
    expect(state.loadFailed).toBe(false);
  });

  it('빈 배열이면 fetch를 안 태운다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness derivedIds={[]} />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump().keys).toEqual([]);
  });

  it('전부 실패하면 loadFailed=true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness derivedIds={['d1']} />); });
    await flush();

    expect(dump()).toEqual({ keys: [], counts: [], loading: false, loadFailed: true });
  });
});
