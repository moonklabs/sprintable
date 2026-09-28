import { notFound } from 'next/navigation';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { ConnectRulesV3Screen } from '@/components/connect-rules-v3/connect-rules-v3-screen';

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N·FE) — 시안 ⑤ 그대로. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션 가드만
 * 재구현, 「오늘」#3962·「대화」#3972 선례 동형). 새 BE 0(전부 기존 엔드포인트 소비).
 * A(외부 발행 일시 중지 스위치) 절은 #4363(#3953) 착지 뒤 rebase로 후속 추가 예정 — 이
 * PR엔 없음(AC7).
 *
 * story #4017 착지 뒤 재정정(2026-09-22) — env 이름 3개를 각자 읽던 임시 readNavV3Flags()
 * (#4004 rebase 시점 임시 패턴)를 readNavV3FlagsFromEnv() 한 곳 위임으로 교체(#4004
 * 조건 ①). notFound() 게이트도 같은 flags 객체를 재사용 — CONNECT_RULES_V3_ENABLED를
 * 두 번 안 읽는다. story #4004 — 목적지·nav 렌더는 공유 `NavV3ItemList`
 * (nav-v3-item-list.tsx)로, 이 화면 자신은 목적지 리터럴을 안 가진다.
 */
export default function ConnectRulesV3Page() {
  const flags = readNavV3FlagsFromEnv();
  if (!flags.connectRulesV3Enabled) notFound();

  return <ConnectRulesV3Screen flags={flags} />;
}
