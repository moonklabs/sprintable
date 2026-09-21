// @vitest-environment jsdom
//
// story #4075(AC1/AC6) — use-marketing-recipes.test.tsx와 동일 하네스 구조: 훅을 쓰는 최소
// 컴포넌트를 렌더하고 state를 JSON dump로 읽는다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRecipeStartCandidates, type RecipeStartCandidate } from './use-recipe-start-candidates';

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

function candidateStub(overrides: Partial<RecipeStartCandidate> = {}): RecipeStartCandidate {
  return {
    definition_id: 'def-1', key: 'org.acme.recipe', name: '테스트 레시피', first_stage: 'draft',
    role_bound: true, started: false, conversation_id: null, message_id: null,
    current_stage: null, current_role: null, next_stage: null, next_role: null, last_published_at: null,
    current_stage_position: null, total_stages: null,
    ...overrides,
  };
}

function Harness({ projectId }: { projectId?: string }) {
  const { candidates, loading, error } = useRecipeStartCandidates(projectId, 'story', 'story-1');
  return (
    <div data-testid="dump">
      {JSON.stringify({ candidates: candidates.map((c) => c.key), loading, error })}
    </div>
  );
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

describe('useRecipeStartCandidates', () => {
  it('project_id/work_item_type/work_item_id를 쿼리로 실어 GET한다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/events/definitions/start-candidates?project_id=proj-1&work_item_type=story&work_item_id=story-1');
      return { ok: true, json: async () => ({ candidates: [candidateStub()] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();

    expect(dump().candidates).toEqual(['org.acme.recipe']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('{data:{candidates:[...]}} envelope도 받아들인다(publish-history/bindings와 동일 방어적 unwrap)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: { candidates: [candidateStub({ key: 'org.acme.other' })] } }),
    })));

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();
    expect(dump().candidates).toEqual(['org.acme.other']);
  });

  it('projectId가 없으면 fetch하지 않고 빈 배열', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness />); });
    await flush();

    const state = dump();
    expect(state.candidates).toEqual([]);
    expect(state.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('네트워크 실패 시 error를 채우고 candidates는 빈 배열(조용한 삼킴 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();

    const state = dump();
    expect(state.candidates).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).not.toBeNull();
  });
});
