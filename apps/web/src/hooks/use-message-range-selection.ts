import { useCallback, useMemo, useState } from 'react';

export type MessageRangeSelectionMode = 'idle' | 'anchored' | 'confirming';

interface SelectionState {
  mode: MessageRangeSelectionMode;
  anchorId: string | null;
  rangeStartId: string | null;
  rangeEndId: string | null;
}

const IDLE_STATE: SelectionState = { mode: 'idle', anchorId: null, rangeStartId: null, rangeEndId: null };

export interface MessageRangeSelection extends SelectionState {
  /** story #2265(C-7) ①규격 — 「여기부터」. 메시지 단위 두 번 짚기의 첫 짚기. */
  startSelection: (messageId: string) => void;
  /** 「여기까지」 — orderedMessageIds(지금 보는 목록 순서, 위→아래)로 anchor와 이 id의
   * 시간순을 정규화한다(사용자가 나중 메시지를 먼저 짚어도 range가 뒤집히지 않게).
   * anchor나 이 id가 orderedMessageIds에 없으면(가상화로 목록 밖으로 밀려난 경우 등)
   * 조용히 무시한다 — 순서를 모르는 채로 range를 지어내지 않는다. */
  confirmEnd: (messageId: string, orderedMessageIds: string[]) => void;
  cancel: () => void;
  isAnchor: (messageId: string) => boolean;
  /** mode==='confirming'일 때만 의미 있다 — orderedMessageIds 안에서 rangeStartId~rangeEndId
   * 사이(양끝 포함)인지. 목록이 바뀌어도(가상화 스크롤 등) 항상 그 시점의 순서로 판정한다. */
  isInRange: (messageId: string, orderedMessageIds: string[]) => boolean;
}

/**
 * story #2265(C-7) PR2 — 대화 일부를 proof로 박기 위한 메시지 범위 선택 상태 기계.
 * 순수 상태만 다룬다(저장/전송은 이 훅의 책임 밖 — write 엔드포인트가 서면 소비부가
 * confirmEnd 이후의 rangeStartId/rangeEndId를 그대로 payload에 실어 보낸다).
 *
 * ⛔문자 드래그가 아니라 메시지 "단위" 두 번 짚기(유나 확定 규격, PO 채택) — anchor
 * 자체를 붙잡아 두고 orderedMessageIds로 사후 정규화하는 이유: 채팅은 실시간으로 새
 * 메시지가 위/아래에 계속 추가되므로, index 스냅샷이 아니라 "그 순간의 목록 순서"를
 * confirmEnd 호출 시점마다 다시 받아 판정해야 정확하다.
 */
export function useMessageRangeSelection(): MessageRangeSelection {
  const [state, setState] = useState<SelectionState>(IDLE_STATE);

  const startSelection = useCallback((messageId: string) => {
    setState({ mode: 'anchored', anchorId: messageId, rangeStartId: null, rangeEndId: null });
  }, []);

  const confirmEnd = useCallback((messageId: string, orderedMessageIds: string[]) => {
    setState((prev) => {
      if (prev.mode !== 'anchored' || !prev.anchorId) return prev;
      const anchorIndex = orderedMessageIds.indexOf(prev.anchorId);
      const endIndex = orderedMessageIds.indexOf(messageId);
      // 이 분기는 지금 도는 경로가 없다(2026-07-29 확認 — chat-view.tsx엔 가상화 라이브러리가
      // 0건이고 messages state는 prepend만 해 축소되지 않는다, 언마운트→재마운트는 선택 자체가
      // 정상 취소되는 별개 경로). ⇒ 가상화가 들어오면 이 분기가 돈다 — 그때는 "무시"가 아니라
      // "다른 데서(서버/스토어) 순서를 다시 얻는" 쪽으로 바꾼다(anchor id 자체는 훅이 계속
      // 들고 있으므로 그 id로 재조회하면 된다). 도는 경로가 없다고 죽은 코드로 지우지 말 것.
      if (anchorIndex === -1 || endIndex === -1) return prev; // 순서를 모르면 확定하지 않는다.
      const [startId, endId] = anchorIndex <= endIndex
        ? [prev.anchorId, messageId]
        : [messageId, prev.anchorId];
      return { mode: 'confirming', anchorId: prev.anchorId, rangeStartId: startId, rangeEndId: endId };
    });
  }, []);

  const cancel = useCallback(() => setState(IDLE_STATE), []);

  const isAnchor = useCallback(
    (messageId: string) => state.mode === 'anchored' && state.anchorId === messageId,
    [state.mode, state.anchorId],
  );

  const isInRange = useCallback(
    (messageId: string, orderedMessageIds: string[]) => {
      if (state.mode !== 'confirming' || !state.rangeStartId || !state.rangeEndId) return false;
      const startIndex = orderedMessageIds.indexOf(state.rangeStartId);
      const endIndex = orderedMessageIds.indexOf(state.rangeEndId);
      const targetIndex = orderedMessageIds.indexOf(messageId);
      if (startIndex === -1 || endIndex === -1 || targetIndex === -1) return false;
      return targetIndex >= startIndex && targetIndex <= endIndex;
    },
    [state.mode, state.rangeStartId, state.rangeEndId],
  );

  return useMemo(
    () => ({ ...state, startSelection, confirmEnd, cancel, isAnchor, isInRange }),
    [state, startSelection, confirmEnd, cancel, isAnchor, isInRange],
  );
}
