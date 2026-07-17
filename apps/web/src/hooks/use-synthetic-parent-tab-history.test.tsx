// @vitest-environment jsdom
//
// story #1959(P2-S3) — useSyntheticParentTabHistory 콜드/내부진입 분기·멱등 가드 회귀 테스트.
// 실 브라우저 세션 history 대신 window.history.pushState/replaceState를 spy로 관찰(네비게이션
// 발생 없음 — jsdom 제약이 아니라 이 훅 자체가 raw history API만 건드리므로 이 검증으로 충분).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSyntheticParentTabHistory } from './use-synthetic-parent-tab-history';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let pushSpy: ReturnType<typeof vi.spyOn>;
let replaceSpy: ReturnType<typeof vi.spyOn>;

function setHistoryLength(n: number) {
  Object.defineProperty(window.history, 'length', { value: n, configurable: true });
}

function setHistoryState(state: unknown) {
  Object.defineProperty(window.history, 'state', { value: state, configurable: true });
}

function TestComp({ parentTabHref }: { parentTabHref: string }) {
  useSyntheticParentTabHistory(parentTabHref);
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushSpy = vi.spyOn(window.history, 'pushState');
  replaceSpy = vi.spyOn(window.history, 'replaceState');
  setHistoryState(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  pushSpy.mockRestore();
  replaceSpy.mockRestore();
});

describe('useSyntheticParentTabHistory', () => {
  it('콜드 진입(history.length===1)이면 parentTab 루트를 선주입한다', () => {
    setHistoryLength(1);
    act(() => root.render(<TestComp parentTabHref="/more" />));

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy.mock.calls[0][2]).toBe('/more');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    // target = 현재 jsdom 기본 URL(pathname+search) 그대로 재푸시
    expect(pushSpy.mock.calls[0][2]).toBe(window.location.pathname + window.location.search);
  });

  it('SPA 내부 진입(history.length>1)이면 아무것도 하지 않는다', () => {
    setHistoryLength(2);
    act(() => root.render(<TestComp parentTabHref="/more" />));

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('이미 합성된 상태(history.state 마커)면 재실행하지 않는다 — 새로고침 재마운트 멱등', () => {
    setHistoryLength(1);
    setHistoryState({ _sprintableSyntheticRoot: true });
    act(() => root.render(<TestComp parentTabHref="/more" />));

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('현재 URL이 이미 parentTab 루트 자체면 합성하지 않는다', () => {
    setHistoryLength(1);
    const originalHref = window.location.href;
    window.history.pushState(null, '', '/more');
    pushSpy.mockClear();

    act(() => root.render(<TestComp parentTabHref="/more" />));

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();

    window.history.pushState(null, '', originalHref);
  });
});
