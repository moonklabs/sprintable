import { notFound } from 'next/navigation';
import { isTodayV3Enabled } from '@/lib/today-v3';
import { TodayV3Screen } from '@/components/today-v3/today-v3-screen';

/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N·FE) — 시안 ①(artifact d31b9e6d) 그대로:
 * 공통 셸(좌 nav 6 + 상단) + 내 결정 큐 + 진행 中 + 오늘 결과. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션
 * 가드만 재구현). 데이터는 기존 `GET /api/v2/today`(story #3823) 1콜 그대로(자체
 * 집계 0) — `use-today-snapshot.ts`가 org-briefing과 공유하는 그 fetch 하나.
 */
export default function TodayV3Page() {
  if (!isTodayV3Enabled()) notFound();

  return <TodayV3Screen />;
}
