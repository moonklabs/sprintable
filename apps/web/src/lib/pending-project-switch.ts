/**
 * story #4226(까디르 QA [P2] · PO 23:17Z · 23:48Z) — 프로젝트 전환 «대기 중 목표». 전환기가 `?p=B` 이동을 시작한 뒤 커밋 전엔 대시보드
 * 컨텍스트가 아직 A라, 그 사이 탭을 누르면 탭 링크(`?p=A`)가 B 이동을 대체하고 URL에 A를 박았다. 전환기(use-unified-switcher)가 이동
 * 시작 때 목표를 적고, **그 이동의 transition이 끝나면**(커밋이든 다른 이동에 밀렸든) 또는 push가 던지면 지운다 — 주소 비교로 추측하지
 * 않는다(같은 URL 이동이 밀어내면 주소가 안 바뀐다). flat 링크의 `?p=`는 이 값을 먼저 본다. 표시·링크 주소 전용 — 권한·데이터 판단 금지.
 */
import { useSyncExternalStore } from 'react';

// 까디르 재QA(011da90c2) — 전역 목표에 주인이 없어, 전환기 인스턴스 X가 사라질 때 X의 정리가 Y가 세운 목표를 지웠다. 목표마다 세대 토큰을
// 달고, 세운 쪽이 자기 토큰으로만 지운다(begin → end(token)). 토큰이 다르면(그 사이 다른 전환이 목표를 새로 세움) 아무것도 안 한다.
let pending: { projectId: string; token: number } | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function beginPendingProjectTarget(projectId: string): number {
  generation += 1;
  pending = { projectId, token: generation };
  notify();
  return generation;
}

export function endPendingProjectTarget(token: number): void {
  if (pending?.token !== token) return;
  pending = null;
  notify();
}

/** 테스트·강제 초기화용 — 운영 코드는 begin/end(token)만 쓴다. */
export function setPendingProjectTarget(projectId: string | null): void {
  if (projectId === null) {
    if (pending === null) return;
    pending = null;
    notify();
    return;
  }
  beginPendingProjectTarget(projectId);
}

export function getPendingProjectTarget(): string | null {
  return pending?.projectId ?? null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function usePendingProjectTarget(): string | null {
  return useSyncExternalStore(subscribe, getPendingProjectTarget, () => null);
}
