'use client';

import { installProjectHeaderInterceptor } from '@/lib/project-context-client';

/**
 * story #4184(PR #4565 PO 위험 (a)) — same-origin `/api/` 요청의 관문(window.fetch 인터셉터)을 **앱 루트**에서 설치한다.
 * 예전엔 DashboardShell 렌더에서만 설치해, 셸 밖 화면(v3 단독 `/today`·`/chat`·`/connect-rules` — 셸 밖 얇은 레이아웃인데
 * fetchMe로 /api/me 캐시를 채운다)으로 바로 들어오면 관문이 없어 그 화면의 쓰기가 /api/me 재사용 캐시를 안 버렸다.
 * 루트 설치는 헤더 주입 동작을 바꾸지 않는다 — 주입은 effective project가 정해졌을 때만(그 값은 셸이 정한다).
 * 렌더 단계에서 부른다(자식 페이지의 첫 fetch보다 먼저, DashboardShell 설치와 같은 이유) — 멱등·SSR 가드.
 */
export function FetchGateInstaller(): null {
  installProjectHeaderInterceptor();
  return null;
}
