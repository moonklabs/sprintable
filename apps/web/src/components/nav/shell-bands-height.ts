'use client';

import { useLayoutEffect, type RefObject } from 'react';

/** 셸이 앵커 화면들(`h-[calc(100svh-var(--shell-chrome-h))]`)에게 «띠 셋이 먹은 높이»를 알려 주는 커스텀 프로퍼티 — globals.css의 `--shell-chrome-h`가 읽는다(4913 셸). */
export const SHELL_BANDS_VAR = '--shell-bands-h';

/**
 * 4913(UI-R5) 셸 — 스크롤러 맨 위의 «있을 때만» 띠 셋(가입 완료 n/5 · 다른 조직 알림 · 계정 회수 안내)은 높이가 정해져 있지 않다(비면 0, 있으면 문장 길이에 따라 34~100px).
 * 앵커 화면은 `100svh − --shell-chrome-h`로 «스크롤러 안 남은 높이»를 잡는데 그 변수가 TopBar만 세어 띠 높이만큼 틀이 창 아래로 넘쳤다(담롱 실측: 1100×420 · 띠 34px → 틀 하단 454 > main 하단 412).
 * 여기서 띠 묶음 한 칸을 재서 셸 뿌리(`.dashboard-shell-root`)의 `--shell-bands-h`에 쓴다 — 값은 그 변수 하나에만 얹혀 앵커 여덟 곳은 손대지 않는다.
 * 줄여서: 값 맞추기가 아니라 «셸이 자기가 먹은 높이를 책임진다». 띠가 생기거나 사라지면(가입 완료 닫기 · 5/5) ResizeObserver가 값을 따라 바꾼다.
 * 반환 = 정리 함수(값을 지우고 관찰을 끝낸다).
 */
export function watchShellBandsHeight(el: HTMLElement): () => void {
  const root = el.closest<HTMLElement>('.dashboard-shell-root');
  if (!root) return () => undefined;
  const write = () => root.style.setProperty(SHELL_BANDS_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
  write(); // 첫 그림 前(layout 단계) — 서버가 그린 첫 값은 «띠 없음»(0)이고 여기서 바로 맞춘다
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(write);
    ro.observe(el);
  }
  return () => {
    ro?.disconnect();
    root.style.removeProperty(SHELL_BANDS_VAR);
  };
}

/** `watchShellBandsHeight`를 layout 효과로 — 첫 그림에 넘침이 한 번 번쩍이지 않게(passive 효과는 그린 뒤에 돈다). */
export function useShellBandsHeight(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? watchShellBandsHeight(el) : undefined;
  }, [ref]);
}
