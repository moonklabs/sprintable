/**
 * story #4226(까디르 QA [P2] · PO 23:17Z · 23:48Z) — 프로젝트 전환 «대기 중 목표». 전환기가 `?p=B` 이동을 시작한 뒤 커밋 전엔 대시보드
 * 컨텍스트가 아직 A라, 그 사이 탭을 누르면 탭 링크(`?p=A`)가 B 이동을 대체하고 URL에 A를 박았다. 전환기(use-unified-switcher)가 이동
 * 시작 때 목표를 적고, **그 이동의 transition이 끝나면**(커밋이든 다른 이동에 밀렸든) 또는 push가 던지면 지운다 — 주소 비교로 추측하지
 * 않는다(같은 URL 이동이 밀어내면 주소가 안 바뀐다). flat 링크의 `?p=`는 이 값을 먼저 본다. 표시·링크 주소 전용 — 권한·데이터 판단 금지.
 */
import { useSyncExternalStore } from 'react';

let pending: string | null = null;
const listeners = new Set<() => void>();

export function setPendingProjectTarget(projectId: string | null): void {
  if (pending === projectId) return;
  pending = projectId;
  for (const l of listeners) l();
}

export function getPendingProjectTarget(): string | null {
  return pending;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function usePendingProjectTarget(): string | null {
  return useSyncExternalStore(subscribe, getPendingProjectTarget, () => null);
}
