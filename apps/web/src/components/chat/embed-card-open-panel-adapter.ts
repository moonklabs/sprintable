import type { ReadingPanelTarget } from './reading-panel';

/**
 * story #2905(S2c①/③④) — `EmbedCard.onOpenReadingPanel`은 (entityType, entityId, title,
 * status, href) 5-인자 위치 시그니처를 받는다(기존 EmbedCard 계약, 변경 없음). 소비부
 * (chat-bubble.tsx의 `p` 핸들러·embed-group.tsx의 캐러셀/간결 리스트)는 전부 object 기반
 * `(target: ReadingPanelTarget) => void` 시그니처를 물고 있어 그 사이를 잇는 어댑터가 필요
 * — 카디르 QA(#3319) 지적: 이전엔 이 변환을 두 파일이 각자 인라인/로컬 함수로 따로
 * 구현하고 있었다(결과 동일·기능 위험 0였지만 "재사용"이라 적은 주석과 실물이 어긋났고,
 * 한쪽만 고치면 드리프트할 위험이 있었다). 이 파일 하나로 수렴해 두 소비부가 **진짜 같은
 * 참조**를 쓴다.
 */
export type EmbedCardOpenPanel = (
  entityType: string,
  entityId: string,
  title: string | null,
  status: string | null,
  href: string | null,
) => void;

export function toEmbedCardOpenPanel(
  onOpenReadingPanel?: (target: ReadingPanelTarget) => void,
): EmbedCardOpenPanel | undefined {
  if (!onOpenReadingPanel) return undefined;
  return (entityType, entityId, title, status, href) =>
    onOpenReadingPanel({ kind: 'entity', entityType, entityId, title, status, href });
}
