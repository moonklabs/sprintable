'use client';

import { useCallback, useMemo } from 'react';
import { useFieldDraft, type FieldDraftKey } from './use-field-draft';

/**
 * story #4370 — 카드 목록처럼 **구조가 있는 값 안에 여러 줄 칸**이 든 폼(가설 선언 목록 등)의 초안.
 * 여러 줄 칸만 떼어 저장하면 목록의 어느 항목 것인지 잃는다 — 값 전체를 JSON 한 덩어리로 `useFieldDraft`에 싣는다(규칙은 그 훅 그대로:
 * 닫혀도 남음 · 성공/«취소»에서만 `clear` · 빈 값(=`empty`와 같음)은 저장 안 함). 깨진 JSON이면 초안 없이 시작.
 */
export function useJsonFieldDraft<T>(
  draftKey: FieldDraftKey,
  empty: T,
): [value: T, setValue: (next: T) => void, clear: () => void] {
  const emptyJson = useMemo(() => JSON.stringify(empty), [empty]);
  const [raw, setRaw, clear] = useFieldDraft(draftKey, emptyJson);
  const value = useMemo<T>(() => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return JSON.parse(emptyJson) as T;
    }
  }, [raw, emptyJson]);
  const setValue = useCallback((next: T) => setRaw(JSON.stringify(next)), [setRaw]);
  return [value, setValue, clear];
}
