// @vitest-environment jsdom
//
// story #4046(E-RECIPE-1 ①) — use-gate-batch.test.tsx와 동일 하네스 구조.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRecipeMemberOptions } from './use-recipe-member-options';

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

function Harness({ projectId }: { projectId: string | null }) {
  const { options, loading, loadFailed } = useRecipeMemberOptions(projectId);
  return <div data-testid="dump">{JSON.stringify({ options, loading, loadFailed })}</div>;
}

function dump() {
  return JSON.parse(container.querySelector('[data-testid="dump"]')!.textContent!);
}

describe('useRecipeMemberOptions — agent+human 혼합 조회(type 파라미터 생략)', () => {
  it('GET /api/team-members?project_id=X를 type 없이 호출하고 agent+human 그대로 반환한다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/team-members?project_id=proj-1');
      expect(url).not.toContain('type=');
      return {
        ok: true,
        json: async () => [
          { id: 'agent-1', name: '크리에이터봇', type: 'agent' },
          { id: 'human-1', name: '윤재', type: 'human' },
        ],
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();

    const state = dump();
    expect(state.options).toEqual([
      { id: 'agent-1', name: '크리에이터봇', type: 'agent' },
      { id: 'human-1', name: '윤재', type: 'human' },
    ]);
    expect(state.loading).toBe(false);
    expect(state.loadFailed).toBe(false);
  });

  // story #4071 qa:changes 부수(카디르, 2026-09-19) — 기존 스위트는 성공 응답을 전부
  // 원시 배열로만 mock해 `Array.isArray(json) ? json : (json.data ?? [])`의 else 분기
  // (BFF가 `{data:[...]}` envelope로 감싸 낼 때)가 한 번도 실행되지 않았다 —
  // `?? []`를 지워도(=json.data가 undefined일 때 크래시) 기존 5건이 그대로 통과했을
  // 것([못틀리는대조미자]). envelope 모양 응답으로 그 분기 자체를 pin.
  it('응답이 {data:[...]} envelope 모양이어도(원시 배열 아님) data를 그대로 낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [{ id: 'agent-2', name: '봇', type: 'agent' }] }),
    })));

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();

    expect(dump().options).toEqual([{ id: 'agent-2', name: '봇', type: 'agent' }]);
  });

  it('응답이 {data:[...]} envelope인데 data 필드 자체가 없으면 빈 배열로 방어한다(핵심 회귀 — ?? [] 제거 시 크래시)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();

    expect(dump()).toEqual({ options: [], loading: false, loadFailed: false });
  });

  it('projectId가 null이면 fetch 자체를 안 태우고 빈 옵션', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness projectId={null} />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump().options).toEqual([]);
  });

  it('실패 시 loadFailed=true — 0명(진짜 없음)과 구분(story #3521 관례)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await act(async () => { root.render(<Harness projectId="proj-1" />); });
    await flush();

    const state = dump();
    expect(state.options).toEqual([]);
    expect(state.loadFailed).toBe(true);
  });

  it('projectId가 바뀌면 새로 fetch한다', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true, json: async () => [{ id: `m-${url}`, name: 'x', type: 'agent' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    function Switcher() {
      const [pid, setPid] = useState('proj-1');
      return (
        <>
          <button data-testid="switch" onClick={() => setPid('proj-2')}>switch</button>
          <Harness projectId={pid} />
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

  it('조회 中 projectId가 null로 바뀌면 loading이 고착되지 않는다(카디르 QA #4421 qa:changes 재현)', async () => {
    let resolveFetch: (() => void) | null = null;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveFetch = () => resolve({ ok: true, json: async () => [] });
    }));
    vi.stubGlobal('fetch', fetchMock);

    function Switcher() {
      const [pid, setPid] = useState<string | null>('proj-1');
      return (
        <>
          <button data-testid="clear" onClick={() => setPid(null)}>clear</button>
          <Harness projectId={pid} />
        </>
      );
    }

    await act(async () => { root.render(<Switcher />); });
    await flush();
    expect(dump().loading).toBe(true); // 응답 도착 前 — 조회 中.

    // projectId가 조회 中에 null로 바뀐다(프로젝트 전환) — 이전 effect는 cleanup으로
    // cancelled=true, 새 effect는 !projectId 분기.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="clear"]')!.click(); });
    await flush();
    expect(dump().loading).toBe(false); // 고착 안 됨(수정 前엔 true로 남아 FAIL).

    // 이전 in-flight 응답이 뒤늦게 와도(cancelled) loading을 다시 안 켠다.
    await act(async () => { resolveFetch?.(); });
    await flush();
    expect(dump().loading).toBe(false);
  });

  // story #4071 qa:changes(카디르, #4444와 동일 클래스, 2026-09-19) — 원본 skip 조건
  // `if (!projectId)`는 falsy 전부(빈 문자열 포함)를 스킵으로 봤다. useAsyncResource의
  // skip 판정은 null/undefined만 인식하므로, projectId=''를 정규화 없이 넘기면 실제
  // fetch가 나가 "기존동작 무변" 계약이 깨진다 — 핵심 회귀.
  it('projectId가 빈 문자열이어도(falsy) fetch 자체를 호출하지 않는다(#4071 재QA 핵심 회귀)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<Harness projectId="" />); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dump()).toEqual({ options: [], loading: false, loadFailed: false });
  });
});
