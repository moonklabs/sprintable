'use client';

import type { ReactNode } from 'react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';

/** 조직 구역 화면 제목의 «모양» 한 곳 — 화면(OrgScreenTitle)과 로딩 폴백(flat-tab-top-bar의 조직 제목)이 같이 쓴다(둘이 갈리지 않게 · story 4326 방식). */
export function OrgTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-sm font-medium">{children}</h1>;
}

/**
 * 4913(UI-R5) 조직 구역 화면 제목 — 앱 틀 위 막대에 올린다(PO 11-12: 보드 · 목표 · 문서 · 실행 등 다시 지은 화면과 같은 자리).
 * 본문에는 별도 마스트헤드(`h1`)가 없으므로 이 자리의 `h1`이 그 화면의 유일한 `h1`이다(TopBarSlot 규칙 — story #3945/#3946).
 * 화면은 **모든 분기**(로딩 · 권한 없음 · 빈 · 정상)에서 이것을 그린다 — 분기마다 위 막대가 비지 않게(권한 화면의 early return이 제목을 지우던 길을 막는다).
 * 라우트 로딩(`loading.tsx`)은 같은 제목을 `RouteTopBarFallback`(FLAT_ROUTE_TOP_BAR)으로 쥔다 — 화면이 뜨기 전에도 막대가 비지 않는다.
 * 화면 제목 글은 사이드바 이름과 같은 한 가지 이름이다(`verify-nav-label-matches-title`).
 */
export function OrgScreenTitle({ children }: { children: ReactNode }) {
  return <TopBarSlot title={<OrgTitle>{children}</OrgTitle>} />;
}
