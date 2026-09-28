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

  // story #4071 qa:changes 부수(카디르 #4446 재발견, 2026-09-19, 동일 클래스 자기점검) —
  // 기존 스위트는 성공 응답을 전부 원시 배열로만 mock해
  // `Array.isArray(json) ? json : (json.data ?? [])`의 else 분기(BFF envelope)가
  // 한 번도 실행되지 않았다 — `?? []`를 지워도 기존 테스트가 통과했을 것
  // ([못틀리는대조미자]). envelope 모양 응답으로 그 분기 자체를 pin.
  it('응답이 {data:[...]} envelope 모양이어도(원시 배열 아님) data를 그대로 낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [REPORT_EVIDENCE('storyboard', 'e1')] }),
    })));

    await act(async () => { root.render(<Harness workItemId="story-1" workItemType="story" />); });
    await flush();

    expect(dump().kinds).toEqual(['storyboard']);
  });

  it('응답이 {data:[...]} envelope인데 data 필드 자체가 없으면 빈 배열로 방어한다(핵심 회귀 — ?? [] 제거 시 크래시)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));

    await act(async () => { root.render(<Harness workItemId="story-1" workItemType="story" />); });
    await flush();

    expect(dump()).toEqual({ kinds: [], loading: false, loadFailed: false });
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

  // story #4071 qa:changes(카디르, #4444와 동일 클래스, 2026-09-19) — 원본 skip 조건은
  // `!workItemId || !workItemType`로 falsy 전부(빈 문자열 포함)를 스킵했다. 이 마이그는
  // 복합 key(`workItemId && workItemType ? \`${workItemId}:${workItemType}\` : null`)를
  // `&&`로 만들어 workItemId=''면 그 자체로 이미 falsy라 key가 null이 된다(useAsyncResource
  // 전달 前에 정규화 완료) — 다른 3훅(org-domain-labels·channel-calendar·recipe-member-
  // options)처럼 원본 값을 그대로 넘기지 않아 이 클래스에 애초에 안 걸림을 확認.
  it('workItemId가 빈 문자열이어도(falsy) fetch 자체를 호출하지 않는다(#4071 재QA 클래스 자기점검)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness workItemId="" workItemType="story" />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump()).toEqual({ kinds: [], loading: false, loadFailed: false });
  });
});
