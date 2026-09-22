import { notFound } from 'next/navigation';
import { isConnectRulesV3Enabled } from '@/lib/connect-rules-v3';
import { ConnectRulesV3Screen } from '@/components/connect-rules-v3/connect-rules-v3-screen';

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N·FE) — 시안 ⑤ 그대로. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션 가드만
 * 재구현, 「오늘」#3962·「대화」#3972 선례 동형). 새 BE 0(전부 기존 엔드포인트 소비).
 * A(외부 발행 일시 중지 스위치) 절은 #4363(#3953) 착지 뒤 rebase로 후속 추가 예정 — 이
 * PR엔 없음(AC7).
 *
 * PO CHANGES-8(2026-09-17) — 이 서버 컴포넌트가 「오늘」·「대화」 v3 플래그를 직접 읽어
 * prop으로 내려준다(그 두 화면 자체는 여전히 무접촉 — 여긴 env 플래그만 안다). 두 플래그
 * 다 develop 미착지라 오늘은 항상 false로 평가되지만, 착지 뒤 별도 코드 변경 없이 자동
 * 전환된다(process.env 직접 읽기라 두 화면의 `is*V3Enabled()` 헬퍼가 아직 없어도 안전).
 */
export default function ConnectRulesV3Page() {
  if (!isConnectRulesV3Enabled()) notFound();

  const todayV3Enabled = process.env['TODAY_V3_ENABLED'] === 'true';
  const chatV3Enabled = process.env['CHAT_V3_ENABLED'] === 'true';

  return <ConnectRulesV3Screen todayV3Enabled={todayV3Enabled} chatV3Enabled={chatV3Enabled} />;
}
