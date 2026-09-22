import { notFound } from 'next/navigation';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { TodayV3Screen } from '@/components/today-v3/today-v3-screen';

/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N·FE) — 시안 ①(artifact d31b9e6d) 그대로:
 * 공통 셸(좌 nav 6 + 상단) + 내 결정 큐 + 진행 中 + 오늘 결과. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션
 * 가드만 재구현). 데이터는 기존 `GET /api/v2/today`(story #3823) 1콜 그대로(자체
 * 집계 0) — `use-today-snapshot.ts`가 org-briefing과 공유하는 그 fetch 하나.
 *
 * story #4017 착지 뒤 재정정(2026-09-22) — env 이름 3개를 각자 읽던 임시 readNavV3Flags()
 * (#4004 rebase 시점 임시 패턴)를 readNavV3FlagsFromEnv() 한 곳 위임으로 교체(#4004
 * 조건 ①). notFound() 게이트도 같은 flags 객체를 재사용.
 */
export default function TodayV3Page() {
  const flags = readNavV3FlagsFromEnv();
  if (!flags.todayV3Enabled) notFound();

  return <TodayV3Screen flags={flags} />;
}
