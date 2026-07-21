'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UseFocusTrapOptions {
  /** false면 Escape를 이 훅이 처리하지 않는다 — 호출부가 이미 자기만의(예: 편집모드 우선
   * 취소 등) Escape 로직을 갖고 있을 때 이중/충돌 핸들러를 피하기 위함. 기본 true. */
  handleEscape?: boolean;
}

/**
 * story #2061 — 손수 구현된 모달 중 공용 Dialog(base-ui)로 바로 교체하기 어려운 자리
 * (예: contextual-panel-layout.tsx의 반응형 드로어 — renderPanel 렌더prop이 inline 컬럼/
 * 드로어 두 모드를 동시에 지원해 Dialog Popup으로 감쌀 수 없다)를 위한 최소 포커스 트랩.
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
