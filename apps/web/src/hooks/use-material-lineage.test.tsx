// @vitest-environment jsdom
//
// story #4063(E-RECIPE-1 ④ 렌더) — use-work-item-production-evidence.test.tsx와 동일 하네스.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMaterialLineage } from './use-material-lineage';

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

function Harness({ workItemId }: { workItemId: string | null }) {
  const { edges, loading, loadFailed } = useMaterialLineage(workItemId);
  return <div data-testid="dump">{JSON.stringify({ ids: edges.map((e) => e.id), loading, loadFailed })}</div>;
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

const EDGE = (id: string) => ({
  id, source_evidence_id: 'ev-1', derived_kind: 'channel_post_draft', derived_id: `d-${id}`,
  relation_kind: 'platform_cut', variant_axis: 'reels', hook_key: null, work_item_id: 'story-1',
});

describe('useMaterialLineage — GET /api/v2/material-lineage?work_item_id=', () => {
  it('work_item_id 쿼리로 호출하고 응답 edges를 그대로 낸다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/v2/material-lineage?work_item_id=story-1');
      return { ok: true, json: async () => [EDGE('e1'), EDGE('e2')] };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness workItemId="story-1" />); });
    await flush();

    expect(dump()).toEqual({ ids: ['e1', 'e2'], loading: false, loadFailed: false });
  });

  it('workItemId가 null이면 fetch 자체를 안 태운다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness workItemId={null} />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump().ids).toEqual([]);
  });

  it('실패 시 loadFailed=true — 0건(진짜 없음)과 구분', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness workItemId="story-1" />); });
    await flush();

    expect(dump()).toEqual({ ids: [], loading: false, loadFailed: true });
  });

  it('workItemId가 바뀌면 새로 fetch한다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal('fetch', fetchMock);

    function Switcher() {
      const [id, setId] = useState('story-1');
      return (
        <>
          <button data-testid="switch" onClick={() => setId('story-2')}>switch</button>
          <Harness workItemId={id} />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="switch"]')!.click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
