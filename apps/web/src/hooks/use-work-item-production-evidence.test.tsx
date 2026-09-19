// @vitest-environment jsdom
//
// story #4041/#4046 후속(비-게이트 forward) — use-recipe-member-options.test.tsx와 동일 하네스.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWorkItemProductionEvidence } from './use-work-item-production-evidence';

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

function Harness({ workItemId, workItemType }: { workItemId: string | null; workItemType: 'story' | 'task' | null }) {
  const { items, loading, loadFailed } = useWorkItemProductionEvidence(workItemId, workItemType);
  return <div data-testid="dump">{JSON.stringify({ kinds: items.map((i) => i.kind), loading, loadFailed })}</div>;
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

const REPORT_EVIDENCE = (kind: string, id: string) => ({
  id, type: 'report', ref: id, source: null, note: null, created_by: null,
  created_at: '2026-09-18T00:00:00Z', org_id: 'org-1', work_item_id: 'story-1', work_item_type: 'story',
  artifact_version_id: null, artifact_id: null, artifact_version_number: null,
  payload: { kind },
});

describe('useWorkItemProductionEvidence — GET /api/evidence를 제작 작업대 5종으로 좁혀 낸다', () => {
  it('work_item_id·work_item_type 쿼리로 호출하고, 5종 밖 evidence는 걸러낸다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/evidence?work_item_id=story-1&work_item_type=story');
      return {
        ok: true,
        json: async () => [
          REPORT_EVIDENCE('storyboard', 'e1'),
          REPORT_EVIDENCE('generation_cost', 'e2'), // #4041 범위 밖 kind — 안 챙김.
          { ...REPORT_EVIDENCE('storyboard', 'e3'), type: 'url' }, // type 불일치 — 안 챙김.
        ],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness workItemId="story-1" workItemType="story" />); });
    await flush();

    const state = dump();
    expect(state.kinds).toEqual(['storyboard']);
    expect(state.loading).toBe(false);
    expect(state.loadFailed).toBe(false);
  });

  it('workItemId가 null이면 fetch 자체를 안 태운다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness workItemId={null} workItemType="story" />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump().kinds).toEqual([]);
  });

  it('실패 시 loadFailed=true — 0건(진짜 없음)과 구분(story #3521 관례)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness workItemId="story-1" workItemType="story" />); });
    await flush();

    const state = dump();
    expect(state.kinds).toEqual([]);
    expect(state.loadFailed).toBe(true);
  });

  it('workItemId가 바뀌면 새로 fetch한다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal('fetch', fetchMock);

    function Switcher() {
      const [id, setId] = useState('story-1');
      return (
        <>
          <button data-testid="switch" onClick={() => setId('story-2')}>switch</button>
          <Harness workItemId={id} workItemType="story" />
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

  it('조회 中 workItemId가 null로 바뀌면 loading이 고착되지 않는다(카디르 QA #4431 qa:changes 재현 — #4421과 같은 클래스)', async () => {
    let resolveFetch: (() => void) | null = null;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, json: async () => [] });
    }));
    vi.stubGlobal('fetch', fetchMock);

    function Switcher() {
      const [id, setId] = useState<string | null>('story-1');
      return (
        <>
          <button data-testid="clear" onClick={() => setId(null)}>clear</button>
          <Harness workItemId={id} workItemType="story" />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(dump().loading).toBe(true); // 응답 도착 前 — 조회 中.

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="clear"]')!.click(); });
    await flush();
    expect(dump().loading).toBe(false); // 고착 안 됨(수정 前엔 true로 남아 FAIL).

    await act(async () => { resolveFetch?.(); });
    await flush();
    expect(dump().loading).toBe(false);
  });
});
