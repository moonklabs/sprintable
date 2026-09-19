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

  // story #4436 qa:changes(카디르, 2026-09-19) — hookKeys가 값→빈 배열로 바뀌면 그 guard가
  // setLoading(false)를 빼먹어 loading이 영구 true로 고착됐다(use-material-lineage.ts와
  // 동일 클래스).
  it('fetch 진행 중 hookKeys가 빈 배열로 바뀌면 loading이 고착되지 않는다(#4436 회귀)', async () => {
    let resolveFetch: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, json: async () => SUMMARY('hook_a') });
    })));

    function Clearer() {
      const [keys, setKeys] = useState<string[]>(['hook_a']);
      return (
        <>
          <button data-testid="clear" onClick={() => setKeys([])}>clear</button>
          <Harness hookKeys={keys} />
        </>
      );
    }

    await act(async () => { root.render(<Clearer />); });
    await flush();
    expect(dump().loading).toBe(true); // fetch 아직 미해결.

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="clear"]')!.click(); });
    await flush();
    expect(dump().loading).toBe(false); // 빈 배열 전환 즉시 loading이 풀려야 한다.

    await act(async () => { resolveFetch?.(); });
    await flush();
    expect(dump().loading).toBe(false);
  });

  // story #4436 qa:changes round-2(카디르, 2026-09-19) — hook_key는 문자 제약이 없어 공백을
  // 포함할 수 있다(doc §3① "임의 문자열"). 공백 구분자였을 때 ['hook a']가 split(' ')로
  // ['hook','a'] 2개로 잘못 갈라져 실제로 부른 fetch 수가 어긋났다(핵심 회귀).
  it('hook_key에 공백이 섞여 있어도 오분할되지 않고 딱 그 키 하나로 fetch한다(#4436 round-2 회귀)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      return { ok: true, json: async () => SUMMARY(key) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness hookKeys={['hook a']} />); });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/material-lineage/hook-performance?hook_key=hook+a', undefined);
    expect(dump().keys).toEqual(['hook a']);
  });

  // 공백 구분자였을 때 ['a b','c']와 ['a','b c']가 우연히 같은 join 결과("a b c")를 내
  // 서로 다른 키 집합인데 재요청을 스킵하는 더 심한 사고도 났다(카디르 지적) — 서로 다른
  // 두 집합이 서로 다른 fetch 횟수를 내는지로 pin.
  it('서로 다른 hook_key 집합이 공백 join 시 우연히 같은 문자열을 내도(예: ["a b","c"] vs ["a","b c"]) depsKey가 다르게 구분된다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      return { ok: true, json: async () => SUMMARY(key) };
    });
    vi.stubGlobal('fetch', fetchMock);

    function Switcher() {
      const [which, setWhich] = useState<'first' | 'second'>('first');
      const keys = which === 'first' ? ['a b', 'c'] : ['a', 'b c'];
      return (
        <>
          <button data-testid="switch" onClick={() => setWhich('second')}>switch</button>
          <Harness hookKeys={keys} />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dump().keys.sort()).toEqual(['a b', 'c']);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch"]')!.click(); });
    await flush();
    // 집합이 실제로 바뀌었으니 재요청이 일어나야 한다(합쳐서 4회) — 수정 前엔 depsKey가
    // 우연히 같아 여기서 재요청이 스킵되고 keys도 옛 집합("a b","c")에 고착됐을 자리.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(dump().keys.sort()).toEqual(['a', 'b c']);
  });
});
