'use client';

import { useEffect, useRef } from 'react';
import { leaveMultilineFieldOnEsc } from '@/lib/inner-layer-esc';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UseFocusTrapOptions {
  /** false면 Escape를 이 훅이 처리하지 않는다 — 호출부가 이미 자기만의(예: 편집모드 우선
   * 취소 등) Escape 로직을 갖고 있을 때 이중/충돌 핸들러를 피하기 위함. 기본 true. */
  handleEscape?: boolean;
}

/**
 * story #2061 — 손수 구현된 모달 중 공용 Dialog(base-ui)로 바로 교체하기 어려운 자리를 위한 최소 포커스 트랩.
 * (story 4831: contextual-panel-layout의 서랍은 이 훅 없이 바탕 Sheet로 옮겼다 — 서랍 가지에서만 renderPanel을 따로 부르므로 감쌀 수 있었다.
 * 남은 쓰임은 같은 요소가 docked ↔ overlay로 모양만 바뀌는 채팅 레일 · 손가락을 따라 움직이는 스와이프 서랍 · 풀스크린 오버레이처럼 Dialog로 못 옮기는 자리다.)
 *
 * active===true인 동안: 컨테이너 안으로 초점을 옮기고, Tab이 컨테이너를 새지 않게 순환시키며,
 * Escape를 누르면 onClose를 호출한다. active가 false로 돌아가면(닫힘) 여는 것 직전의 포커스
 * 자리로 되돌린다(AC3 — 트랩만 있고 반환이 없으면 사용자가 화면 처음으로 튕긴다).
 */
export function useFocusTrap(active: boolean, onClose: () => void, options: UseFocusTrapOptions = {}) {
  const { handleEscape = true } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusables()[0];
    (first ?? container).focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!handleEscape) return;
        // [SID:4367] 한 Esc = 한 층 — 안쪽 층(새 폴더 입력칸 · 후보 목록 · 포털 메뉴 등)이 이 Esc로 자기를 닫고
        // preventDefault로 «썼다»고 표시했으면 서랍은 그대로 둔다. 안쪽 React 핸들러는 뿌리에서 이 리스너보다 먼저 돈다.
        if (e.defaultPrevented) return;
        // [SID:4369] 유나 규칙 — 조합 중 Esc는 조합만 · 글 있는 여러 줄 칸의 첫 Esc는 칸에서만 빠져나옴(초점 = 서랍 뿌리) · 둘째 Esc = 서랍 닫힘.
        if (leaveMultilineFieldOnEsc(e, container)) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [active, onClose, handleEscape]);

  return containerRef;
}
