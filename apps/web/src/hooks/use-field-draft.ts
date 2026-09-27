'use client';

import { useCallback, useState } from 'react';

/**
 * story #4370 — 창 · 패널 안 **여러 줄 글 칸**의 초안(유나 규칙: 닫는 길과 무관하게 유지 · 보내기/저장 성공 때만 지움 · 버림은 보이는 «취소»로만).
 *
 * 창 · 패널이 ✕ · 바깥 누름 · 다른 대상으로 이동으로 닫히면 글 상태가 창 안(useState)과 함께 사라졌다. 이 훅은 글을 sessionStorage에 둔다:
 * - 키 = 표면 + 대상 id + 칸(`sprintable:field-draft:v1:{surface}:{target}:{field}`) — 다른 대상 칸엔 안 샌다(대상이 바뀌면 그 대상의 초안을 읽음).
 * - `initialValue`(서버 값 · 편집 칸)와 같아지면 키를 지운다(초안 = 서버와 다른 쓴 글만) — 글을 고쳐 같아질 때도 · 서버 값이 초안과 같아질 때도.
 *   빈 칸도 지운다(chat-input 초안과 같은 관례).
 * - `clear()` = 저장/보내기 성공 · 보이는 «취소»에서만 부른다(닫힘에선 안 부름).
 * - 저장소 접근 실패(프라이빗 모드 · 용량)는 조용히 초안 없이 동작(쓰기 자체는 막지 않음). SSR에선 저장소를 안 만진다.
 * sessionStorage: 같은 탭에서 창을 닫고 다시 여는 길을 지키는 것이 목적 — 탭을 닫은 뒤까지 남기지 않는다(대화 입력은 localStorage로 따로).
 */
export interface FieldDraftKey {
  /** 표면(창 · 패널 이름) — 예: 'goal-create', 'gate-reject' */
  surface: string;
  /** 글이 속한 대상 id(없으면 null = 새로 만들기) */
  targetId: string | null | undefined;
  /** 칸 이름 — 예: 'description', 'reason' */
  field: string;
}

export function fieldDraftStorageKey({ surface, targetId, field }: FieldDraftKey): string {
  return `sprintable:field-draft:v1:${surface}:${targetId ?? 'new'}:${field}`;
}

function read(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // 쓰기 실패 — 초안 없이 계속(입력 · 저장은 막지 않는다).
  }
}

/**
 * 저장된 초안 — 서버 값과 같으면 초안이 아니다(키를 지우고 null). [SID:4369 · 까디르 P3] 지우지 않으면 초안 B가 서버 B와 같아진 뒤
 * 서버가 C로 바뀌었을 때 «저장소에 초안 있음»으로 읽혀 옛 B가 C를 덮어 보였다. 같은 값을 지우는 일이라 두 번 돌아도 같다(렌더 중 불러도 무해).
 */
function draftOrNull(key: string, serverValue: string): string | null {
  const draft = read(key);
  if (draft !== null && draft === serverValue) {
    write(key, null);
    return null;
  }
  return draft;
}

export function useFieldDraft(
  draftKey: FieldDraftKey,
  initialValue = '',
): [value: string, setValue: (next: string) => void, clear: () => void] {
  const key = fieldDraftStorageKey(draftKey);
  const [state, setState] = useState(() => ({ key, initial: initialValue, value: draftOrNull(key, initialValue) ?? initialValue }));

  // 렌더 중 파생(효과 안 setState 없이):
  // - 대상(키)이 바뀌면 그 대상의 초안 — 앞 대상의 글이 새 대상 칸으로 새지 않게.
  // - 서버 값(initial)이 바뀌었는데 쓴 초안이 없으면(또는 초안이 새 서버 값과 같아 지웠으면) 새 서버 값을 따른다(다른 곳에서 저장됨).
  let current = state;
  if (state.key !== key) {
    current = { key, initial: initialValue, value: draftOrNull(key, initialValue) ?? initialValue };
  } else if (state.initial !== initialValue) {
    current = { key, initial: initialValue, value: draftOrNull(key, initialValue) === null ? initialValue : state.value };
  }
  if (current !== state) setState(current);

  const setValue = useCallback((next: string) => {
    setState({ key, initial: initialValue, value: next });
    write(key, next === '' || next === initialValue ? null : next);
  }, [key, initialValue]);

  const clear = useCallback(() => {
    write(key, null);
    setState({ key, initial: initialValue, value: initialValue });
  }, [key, initialValue]);

  return [current.value, setValue, clear];
}
