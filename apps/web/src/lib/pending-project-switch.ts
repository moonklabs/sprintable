/**
 * story #4226(까디르 QA [P2] · PO 23:17Z) — 프로젝트 전환 «대기 중 목표». 전환기가 `?p=B` 이동을 시작한 뒤 커밋 전엔 대시보드 컨텍스트가
 * 아직 A라, 그 사이 탭을 누르면 탭 링크(`?p=A`)가 B 이동을 대체하고 URL에 A를 박았다(refresh로도 안 돌아옴). 전환기가 이동 시작 때
 * 여기 목표를 **그때의 주소와 함께** 적는다. 지우는 때(PO 23:38Z): 셸이 본 주소가 적을 때의 주소와 달라지면(= 어떤 이동이든 커밋됨)
 * — 목표로 왔든(성공) 뒤로 가기·다른 이동이 먼저 커밋됐든(끊김) 대기는 끝이다. 실패는 전환기가 지운다. 타이머 폴백은 쓰지 않는다.
 * flat 링크의 `?p=`는 이 값을 먼저 본다. 표시·링크 주소 전용 — 권한·데이터 판단에 쓰지 않는다.
 */
import { useSyncExternalStore } from 'react';

let pending: string | null = null;
let pendingFromUrl: string | null = null;
const listeners = new Set<() => void>();

/** 주소 비교용 정규형 — pathname + 쿼리(URLSearchParams 직렬화). 셸의 usePathname·useSearchParams와 같은 모양으로 맞춘다. */
export function normalizeNavUrl(pathname: string, search: string): string {
  const q = new URLSearchParams(search).toString();
  return q ? `${pathname}?${q}` : pathname;
}

function currentNavUrl(): string | null {
  return typeof window === 'undefined' ? null : normalizeNavUrl(window.location.pathname, window.location.search);
}

export function setPendingProjectTarget(projectId: string | null, fromUrl: string | null = projectId ? currentNavUrl() : null): void {
  if (pending === projectId && pendingFromUrl === fromUrl) return;
  pending = projectId;
  pendingFromUrl = projectId ? fromUrl : null;
  for (const l of listeners) l();
}

/** 셸이 커밋된 주소를 볼 때마다 부른다 — 적을 때의 주소와 다르면(이동이 커밋됨) 대기를 끝낸다. */
export function settlePendingProjectTargetOnNavigation(committedUrl: string): void {
  if (pending !== null && pendingFromUrl !== null && committedUrl !== pendingFromUrl) setPendingProjectTarget(null);
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
