'use client';

import { useCallback, useRef, useState } from 'react';
import type { ReadingPanelTarget } from './reading-panel';

export const READING_PANEL_MAX_DEPTH = 3;

export interface ReadingPanelStackApi {
  stack: ReadingPanelTarget[];
  /** activeThreadRef와 동일 이유(popstate stale closure 방지) — 모바일 뒤로가기 제스처가
   * 이 패널을 먼저 닫아야 하는지(페이지 이탈 아님) 판정하는 데 쓰인다. */
  isOpenRef: React.RefObject<boolean>;
  open: (target: ReadingPanelTarget) => void;
  close: () => void;
  navigateTo: (index: number) => void;
}

/**
 * story #2888(S2 R5)·#2898(S2d-FE)·#2904(동역학 테스트 보강) — ReadingPanel 스택 상태+전환
 * 로직을 chat-view.tsx 밖으로 뽑아 무거운 ChatView 전체 마운트 없이 단위 테스트 가능하게 한다.
 * 카디르+codex가 #3303 QA에서 지목한 뮤테이션 무감지 3지점 중 ①②가 이 훅 안에 있다(③=
 * popOne의 pop-vs-close 분기는 reading-panel.tsx 자체 로직이라 reading-panel.test.tsx가 잰다):
 *
 * ①**최대 깊이 truncation** — push 시 `slice(-READING_PANEL_MAX_DEPTH)`로 초과분을
 *   최하단부터 민다(유나군 목업 s2d-sidepane-stack-mockup 확定, 최대 3).
 * ②**history entry "닫힘→열림 1회" 정책** — `isOpenRef`가 이미 열려있으면(스택 비어있지
 *   않음) push만 하고 history는 안 건드린다. 닫힌 상태에서 열릴 때만 `pushState` 1회
 *   (뒤로가기 제스처가 매 push마다 쌓이지 않게).
 *
 * chat-view.tsx는 이 훅의 `open`/`close`를 그대로 안 쓰고 자기 wrapper(`openReadingPanel`/
 * `closeReadingPanel`)로 감싼다 — 스레드 패널과의 상호배타(activeThread 클리어)는 이 훅의
 * 관심사 밖(패널간 조율은 호출부 몫)이라 그대로 chat-view.tsx에 남는다.
 */
export function useReadingPanelStack(): ReadingPanelStackApi {
  const [stack, setStack] = useState<ReadingPanelTarget[]>([]);
  const isOpenRef = useRef(false);

  const open = useCallback((target: ReadingPanelTarget) => {
    const wasClosed = !isOpenRef.current;
    isOpenRef.current = true;
    setStack((prev) => [...prev, target].slice(-READING_PANEL_MAX_DEPTH));
    if (wasClosed) {
      const url = window.location.pathname + window.location.search;
      window.history.pushState({ _sprintableReadingPanel: true }, '', url);
    }
  }, []);

  const close = useCallback(() => {
    isOpenRef.current = false;
    setStack([]);
  }, []);

  const navigateTo = useCallback((index: number) => {
    setStack((prev) => prev.slice(0, index + 1));
  }, []);

  return { stack, isOpenRef, open, close, navigateTo };
}
