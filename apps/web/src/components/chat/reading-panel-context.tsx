'use client';

import { createContext, useContext } from 'react';
import type { ReadingPanelTarget } from './reading-panel';

/**
 * story #461e9a54(P0·선생님 반복 지시, design 스펙 doc 6cf077fc) — 채팅 임베드 엔티티는
 * «전부» 우측 ReadingPanel로. 기존엔 onOpenReadingPanel을 chat-view.tsx→ChatBubble→EmbedCard로
 * 손수 prop-drilling했는데, 그 경로 밖(EntityChip 인라인 멘션·approval-request-card 미리보기)은
 * 배선이 안 닿아 각자 Dialog 모달로 새고 있었다. Context로 "채팅 하위 어디서든 useReadingPanel()"
 * 을 만들면 미래에 새 임베드가 생겨도 자동으로 패널行(모달 재누수 원천 차단, doc §③ "클래스로
 * 닫기"). Provider 밖(EntityChip이 doc-content-renderer.tsx·story-detail-panel.tsx 등 채팅
 * 밖에서도 재사용되는 자리)에서는 null — 소비부가 null이면 기존 Dialog 모달로 폴백(회귀 0).
 */
export interface ReadingPanelContextValue {
  open: (target: ReadingPanelTarget) => void;
  close: () => void;
  /** 스택 내 breadcrumb 이동(use-reading-panel-stack.ts와 동일 계약, index 기반) — 새 대상을
   * 여는 건 항상 open()이다(스택에 이미 열려있으면 push, 닫혀있으면 새 스택으로 그 안에서
   * 처리된다). */
  navigateTo: (index: number) => void;
}

const ReadingPanelContext = createContext<ReadingPanelContextValue | null>(null);

export const ReadingPanelProvider = ReadingPanelContext.Provider;

export function useReadingPanel(): ReadingPanelContextValue | null {
  return useContext(ReadingPanelContext);
}
