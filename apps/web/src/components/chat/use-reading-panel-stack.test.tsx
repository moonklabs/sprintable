// @vitest-environment jsdom
//
// story #2904 — ReadingPanel 스택 «동역학» 단위 테스트(카디르+codex #3303 QA 확定: 정적
// 렌더 테스트뿐이라 뮤테이션 무감지였던 핵심 2건). 무거운 ChatView 전체 마운트 없이,
// 추출된 훅(use-reading-panel-stack.ts)을 작은 harness로 직접 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useReadingPanelStack, READING_PANEL_MAX_DEPTH } from './use-reading-panel-stack';
import type { ReadingPanelTarget } from './reading-panel';

let container: HTMLDivElement;
let root: Root;
let latestApi: ReturnType<typeof useReadingPanelStack> | null = null;

// react-hooks/globals — 렌더 중 모듈 스코프 변수 재할당은 side-effect라 금지된다. useEffect
// 안(렌더 뒤)에서 넘겨받는 건 정당한 side-effect 위치 — thread-panel.test.tsx의 Harness류
// (state 소유 하니스) 패턴과 동형으로, 여기는 훅의 반환 API 자체를 밖으로 노출하는 변형.
function Harness() {
  const api = useReadingPanelStack();
  useEffect(() => { latestApi = api; });
  return (
    <ul>
      {api.stack.map((t) => (
        <li key={t.kind === 'entity' ? t.entityId : t.label}>{t.kind === 'entity' ? t.title : t.label}</li>
      ))}
    </ul>
  );
}

function entity(id: string, title: string): ReadingPanelTarget {
  return { kind: 'entity', entityType: 'story', entityId: id, title, status: null, href: null };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latestApi = null;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('useReadingPanelStack — story #2904 동역학 ①깊이 truncation', () => {
  it('4연속 push(A,B,C,D) — 최대 깊이(3) 초과분이 최하단(A)부터 밀려 [B,C,D]만 남는다', async () => {
    await act(async () => { root.render(<Harness />); });
    const [A, B, C, D] = [entity('a', 'A'), entity('b', 'B'), entity('c', 'C'), entity('d', 'D')];
    await act(async () => {
      latestApi!.open(A);
      latestApi!.open(B);
      latestApi!.open(C);
      latestApi!.open(D);
    });
    expect(latestApi!.stack).toHaveLength(READING_PANEL_MAX_DEPTH);
    expect(latestApi!.stack.map((t) => (t.kind === 'entity' ? t.title : null))).toEqual(['B', 'C', 'D']);
  });
});

describe('useReadingPanelStack — story #2904 동역학 ②history entry "닫힘→열림 1회" 정책', () => {
  it('닫힌 상태에서 첫 open은 pushState를 1회 호출한다', async () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    await act(async () => { root.render(<Harness />); });
    await act(async () => { latestApi!.open(entity('a', 'A')); });
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    expect(pushStateSpy).toHaveBeenCalledWith({ _sprintableReadingPanel: true }, '', expect.any(String));
  });

  it('열려있는 상태에서 연속 push(3회 더)는 pushState를 추가로 호출하지 않는다', async () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    await act(async () => { root.render(<Harness />); });
    await act(async () => { latestApi!.open(entity('a', 'A')); }); // 1회(닫힘→열림)
    pushStateSpy.mockClear();
    await act(async () => {
      latestApi!.open(entity('b', 'B'));
      latestApi!.open(entity('c', 'C'));
      latestApi!.open(entity('d', 'D'));
    });
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('close() 후 다시 open하면(재-닫힘→열림) pushState가 다시 1회 호출된다', async () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    await act(async () => { root.render(<Harness />); });
    await act(async () => { latestApi!.open(entity('a', 'A')); });
    await act(async () => { latestApi!.close(); });
    pushStateSpy.mockClear();
    await act(async () => { latestApi!.open(entity('b', 'B')); });
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
  });
});
