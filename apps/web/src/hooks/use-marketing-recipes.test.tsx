// @vitest-environment jsdom
//
// story #4046(E-RECIPE-1 ①) — use-gate-batch.test.tsx(#5ace2e84)와 동일 하네스 구조:
// 훅을 쓰는 최소 컴포넌트를 렌더하고 state를 JSON dump로 읽는다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMarketingRecipes, isMarketingRecipeKey } from './use-marketing-recipes';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';

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

function defStub(key: string, overrides: Partial<EventDefinitionResponse> = {}): EventDefinitionResponse {
  return {
    id: `id-${key}`, key, org_id: null, name: key, description: null,
    payload_schema: {}, stage_metadata: {}, enabled: true, ...overrides,
  };
}

function Harness() {
  const { recipes, loading, error } = useMarketingRecipes();
  return <div data-testid="dump">{JSON.stringify({ recipes: recipes.map((r) => r.key), loading, error })}</div>;
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

describe('useMarketingRecipes — preset.marketing.* 필터(#4039 PR key 네임스페이스 축 재사용)', () => {
  it('GET /api/events/definitions를 호출해 marketing 도메인만 남긴다 — workflow·org 커스텀은 제외', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/events/definitions');
      return {
        ok: true,
        json: async () => [
          defStub('preset.workflow.dev_flow'),
          defStub('preset.marketing.video_production'),
          defStub('org.acme.custom_def'),
        ],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness />); });
    await flush();

    const state = dump();
    expect(state.recipes).toEqual(['preset.marketing.video_production']);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('{data:[...]} envelope도 받아들인다(events/page.tsx와 동일 방어적 unwrap)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [defStub('preset.marketing.video_production')] }),
    })));

    await act(async () => { root.render(<Harness />); });
    await flush();
    expect(dump().recipes).toEqual(['preset.marketing.video_production']);
  });

  it('네트워크 실패 시 error를 채우고 recipes는 빈 배열(조용한 삼킴 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness />); });
    await flush();

    const state = dump();
    expect(state.recipes).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).not.toBeNull();
  });
});

describe('isMarketingRecipeKey', () => {
  it('preset.marketing.* → true, preset.workflow.*·org 커스텀 → false', () => {
    expect(isMarketingRecipeKey('preset.marketing.video_production')).toBe(true);
    expect(isMarketingRecipeKey('preset.workflow.dev_flow')).toBe(false);
    expect(isMarketingRecipeKey('org.acme.custom_def')).toBe(false);
  });
});
