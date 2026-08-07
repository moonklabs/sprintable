'use client';

import { useEffect, type RefObject } from 'react';
import {
  groupUnresolvedReferencesByType, ENTITY_STATUS_BATCH_API_PATH, type EntityStatusFetchState,
} from '@/components/chat/entity-status-labels';

/** story #2262 PR② — 참조 칩 「지금 상태」 배치조회 effect를 훅으로 뽑았다. chat-view.tsx
 * (메인 채널)와 thread-panel.tsx(스레드 답글) 양쪽이 이 훅을 각자의 `messages`로 부르고,
 * `requestedKeysRef`·`setEntityStatusByKey`는 부모(chat-view.tsx)가 만든 **같은 객체**를
 * 그대로 물려받는다(ThreadPanel은 자기 것을 새로 안 만든다) — 그래야 두 effect가 같은
 * 「이미 요청한 키」 장부를 공유해 중복 fetch가 안 나고, 스레드에서만 처음 보이는 참조도
 * 이 훅이 있는 한 반드시 한쪽 effect가 집어간다(⛔이전엔 스레드 답글 전용 참조가 어느
 * effect의 messages에도 없어 영원히 "아직 모름"에 고착됐다 — PO 지적, 2026-08-08).
 * 타입별로 묶어 `?ids=` 배치 endpoint를 한 번씩만 부른다(메시지마다 N+1 아님). */
export function useEntityStatusBatchFetch(
  messages: Array<{ references?: Array<{ target_type: string; target_id: string }> }>,
  requestedKeysRef: RefObject<Set<string>>,
  setEntityStatusByKey: (updater: (prev: Record<string, EntityStatusFetchState>) => Record<string, EntityStatusFetchState>) => void,
) {
  useEffect(() => {
    const idsByType = groupUnresolvedReferencesByType(messages, requestedKeysRef.current);
    if (idsByType.size === 0) return;

    setEntityStatusByKey((prev) => {
      const next = { ...prev };
      for (const [type, ids] of idsByType) {
        for (const id of ids) next[`${type}:${id}`.toLowerCase()] = { kind: 'loading' };
      }
      return next;
    });

    let cancelled = false;
    for (const [type, ids] of idsByType) {
      fetch(`${ENTITY_STATUS_BATCH_API_PATH[type]}?ids=${ids.map(encodeURIComponent).join(',')}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
        .then((body: { data?: Array<{ id: string; status?: string | null }> }) => {
          if (cancelled) return;
          const items = body.data ?? [];
          setEntityStatusByKey((prev) => {
            const next = { ...prev };
            for (const id of ids) {
              const found = items.find((it) => it.id === id);
              next[`${type}:${id}`.toLowerCase()] = { kind: 'resolved', raw: found?.status ?? null };
            }
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setEntityStatusByKey((prev) => {
            const next = { ...prev };
            for (const id of ids) next[`${type}:${id}`.toLowerCase()] = { kind: 'error' };
            return next;
          });
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestedKeysRef·setEntityStatusByKey는 부모가 안정적으로 물려주는 참조(ref·useState setter)다.
  }, [messages]);
}
