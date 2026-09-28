// @vitest-environment jsdom
//
// story #4063 후속(PR 9dd179582 위) — use-hook-performances.test.tsx와 동일 하네스.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
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

  // story #4437 qa:changes(카디르, 2026-09-19) — derivedIds가 값→빈 배열로 바뀌면 그 guard가
  // setLoading(false)를 빼먹어 loading이 영구 true로 고착됐다(#4436 두 훅과 동일 클래스).
  it('fetch 진행 중 derivedIds가 빈 배열로 바뀌면 loading이 고착되지 않는다(#4437 회귀)', async () => {
    let resolveFetch: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, json: async () => [SNAPSHOT()] });
    })));

    function Clearer() {
      const [ids, setIds] = useState<string[]>(['d1']);
      return (
        <>
          <button data-testid="clear" onClick={() => setIds([])}>clear</button>
          <Harness derivedIds={ids} />
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

  // story #4071 마이그 부수 fix(핵심 회귀) — 원본은 depsKey를 `[...ids].sort().join(' ')`
  // 로 만든 뒤 effect 안에서 `depsKey.split(' ')`로 되돌려 실제 조회 id 배열을 복원했다.
  // derived_id는 FK 없는 서버 원문 필드(hook_key와 동형 축, #4436/#4437 round-2에서
  // 정확히 이 구분자 클래스가 재현됐던 자리)라 공백을 포함할 수 있다 — derivedIds가
  // 정확히 1개(`['id a']`, 공백 포함 단일 id)여도 join·split 왕복이 이를 2개로
  // 오분할('id'·'a')해 엉뚱한 2개 id를 따로 조회했을 것이다. 헬퍼(JSON.stringify 기반
  // keysDepsKey, split 없이 원본 배열 그대로 파싱)로 그 클래스가 사라졌음을 pin.
  it('derived_id 하나가 공백을 포함해도 그 하나를 그대로 조회한다(join·split 오분할 없음, #4071 부수 fix 핵심 회귀)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const id = new URL(url, 'http://x').searchParams.get('derived_id')!;
      return { ok: true, json: async () => (id === 'id a' ? [SNAPSHOT()] : []) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness derivedIds={['id a']} />); });
    await flush();

    // 오분할됐다면 fetch가 2번(derived_id=id, derived_id=a) 나갔을 것 — 실제론 원본
    // 배열 그대로 1개 id에 1번만 나가야 한다.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('derived_id=id+a');
    expect(dump()).toEqual({ keys: ['id a'], counts: [1], loading: false, loadFailed: false });
  });
});
