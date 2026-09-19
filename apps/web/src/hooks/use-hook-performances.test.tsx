// @vitest-environment jsdom
//
// story #4063(E-RECIPE-1 ④ 렌더) — hookKeys 배열만큼 병렬 GET /hook-performance?hook_key=.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useHookPerformances } from './use-hook-performances';

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

function Harness({ hookKeys }: { hookKeys: string[] }) {
  const { summaries, loading, loadFailed } = useHookPerformances(hookKeys);
  return <div data-testid="dump">{JSON.stringify({ keys: Object.keys(summaries), loading, loadFailed })}</div>;
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

const SUMMARY = (hookKey: string) => ({ hook_key: hookKey, variant_count: 2, snapshot_count: 1, totals: { views: 100 } });

describe('useHookPerformances — hookKeys만큼 병렬 GET .../hook-performance?hook_key=', () => {
  it('각 hookKey를 개별 쿼리로 호출하고 맵으로 모은다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      return { ok: true, json: async () => SUMMARY(key) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness hookKeys={['hook_a', 'hook_b']} />); });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dump()).toEqual({ keys: ['hook_a', 'hook_b'], loading: false, loadFailed: false });
  });

  it('빈 배열이면 fetch를 안 태운다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness hookKeys={[]} />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump().keys).toEqual([]);
  });

  it('일부만 실패하면 그 키만 맵에서 빠진다(0 위장 안 함) — 전부 실패해야 loadFailed', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      if (key === 'hook_bad') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => SUMMARY(key) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness hookKeys={['hook_a', 'hook_bad']} />); });
    await flush();

    const state = dump();
    expect(state.keys).toEqual(['hook_a']);
    expect(state.loadFailed).toBe(false);
  });

  it('전부 실패하면 loadFailed=true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness hookKeys={['hook_a']} />); });
    await flush();

    expect(dump()).toEqual({ keys: [], loading: false, loadFailed: true });
  });

  it('같은 키 집합이 순서만 바뀌어 재렌더돼도 재요청 안 함(정규화된 depsKey)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      return { ok: true, json: async () => SUMMARY(key) };
    });
    vi.stubGlobal('fetch', fetchMock);

    function Reorderer() {
      const [order, setOrder] = useState<'ab' | 'ba'>('ab');
      const keys = order === 'ab' ? ['hook_a', 'hook_b'] : ['hook_b', 'hook_a'];
      return (
        <>
          <button data-testid="reorder" onClick={() => setOrder('ba')}>reorder</button>
          <Harness hookKeys={keys} />
        </>
      );
    }

    await act(async () => { root.render(<Reorderer />); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="reorder"]')!.click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
