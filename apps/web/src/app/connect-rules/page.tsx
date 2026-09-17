import { notFound } from 'next/navigation';
import { isConnectRulesV3Enabled } from '@/lib/connect-rules-v3';
import { ConnectRulesV3Screen } from '@/components/connect-rules-v3/connect-rules-v3-screen';

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N·FE) — 시안 ⑤ 그대로. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션 가드만
 * 재구현, 「오늘」#3962·「대화」#3972 선례 동형). 새 BE 0(전부 기존 엔드포인트 소비).
 * A(외부 발행 일시 중지 스위치) 절은 #4363(#3953) 착지 뒤 rebase로 후속 추가 예정 — 이
 * PR엔 없음(AC7).
 */
export default function ConnectRulesV3Page() {
  if (!isConnectRulesV3Enabled()) notFound();

  return <ConnectRulesV3Screen />;
}
