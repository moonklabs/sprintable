'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFieldDraft, type FieldDraftKey } from './use-field-draft';

/**
 * story #4370 — 카드 목록처럼 **구조가 있는 값 안에 여러 줄 칸**이 든 폼(가설 선언 목록 등)의 초안.
 * 여러 줄 칸만 떼어 저장하면 목록의 어느 항목 것인지 잃는다 — 값 전체를 JSON 한 덩어리로 `useFieldDraft`에 싣는다(규칙은 그 훅 그대로:
 * 닫혀도 남음 · 성공/«취소»에서만 `clear` · 빈 값(=`empty`와 같음)은 저장 안 함). 깨진 JSON이면 초안 없이 시작.
 * 저장된 값은 믿지 않고 `empty`의 모양에 맞춘다(`reconcileDraft`) — 폼 모양이 바뀐 뒤 남은 옛 초안이 모르는 키 · 다른 타입을 싣고
 * 들어오지 않게(까디르 P3).
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `stored`를 `template` 모양으로 맞춘다: 객체는 template의 키만(모르는 키 버림) · 키마다 재귀 · 타입이 다르면 template 값.
 * 배열은 배열일 때만 받고, template에 첫 항목이 있으면 그 모양으로 항목마다 맞춘다(객체가 아닌 항목은 버림).
 * template이 null인 자리(예: 아직 없는 지표 정의)는 무엇이든 받는다(undefined 제외). 원시값 자리는 원시값(글 · 수 · 참거짓)만 —
 * `number | ''`처럼 한 칸이 두 원시 타입을 오가는 폼이 있어 typeof까지는 가리지 않는다(객체 · 배열 · null이면 template 값).
 * 못 보는 것: 원시 타입끼리의 뒤바뀜 · template이 null인 자리 안쪽 모양 · 빈 배열 template(항목 모양을 모름)의 항목.
 */
export function reconcileDraft<T>(stored: unknown, template: T): T {
  if (template === null) return (stored === undefined ? template : stored) as T;
  if (Array.isArray(template)) {
    if (!Array.isArray(stored)) return template;
    if (template.length === 0) return stored as T;
    const item = template[0];
    if (isPlainObject(item)) return stored.filter(isPlainObject).map((v) => reconcileDraft(v, item)) as T;
    return stored.filter(isPrimitive) as T;
  }
  if (isPlainObject(template)) {
    if (!isPlainObject(stored)) return template;
    const out: Record<string, unknown> = {};
    for (const [key, fallback] of Object.entries(template)) {
      out[key] = key in stored ? reconcileDraft(stored[key], fallback) : fallback;
    }
    return out as T;
  }
  return (isPrimitive(stored) ? stored : template) as T;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
export function useJsonFieldDraft<T>(
  draftKey: FieldDraftKey,
  empty: T,
): [value: T, setValue: (next: T | ((prev: T) => T)) => void, clear: () => void] {
  const emptyJson = useMemo(() => JSON.stringify(empty), [empty]);
  const [raw, setRaw, clear] = useFieldDraft(draftKey, emptyJson);
  const value = useMemo<T>(() => {
    try {
      return reconcileDraft(JSON.parse(raw) as unknown, JSON.parse(emptyJson) as T);
    } catch {
      return JSON.parse(emptyJson) as T;
    }
  }, [raw, emptyJson]);
  // 업로드처럼 await 뒤에 고치는 자리는 `set((prev) => …)`로 — 그 사이 다른 칸에 쓴 글을 옛 값으로 덮지 않게 최신 값에서 계산한다.
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    const resolved = typeof next === 'function' ? (next as (prev: T) => T)(latest.current) : next;
    latest.current = resolved;
    setRaw(JSON.stringify(resolved));
  }, [setRaw]);
  return [value, setValue, clear];
}
