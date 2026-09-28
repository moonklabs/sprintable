/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — 「오늘」(#3962)·「대화」(#3972) 선례와
 * 같은 모양의 env 플래그 게이트(`isTodayV3Enabled`/`isChatV3Enabled` 동형) — 새 플래그
 * 관례 발명 0.
 *
 * story #4017 착지 뒤 재정정(2026-09-22) — CONNECT_RULES_V3_ENABLED를 직접 process.env로
 * 읽던 것을 nav-v3-flags-server.ts(readNavV3FlagsFromEnv, 단일소스)로 위임 —
 * today-v3.ts::isTodayV3Enabled·chat-v3.ts::isChatV3Enabled와 동형 정렬.
 */
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';

export function isConnectRulesV3Enabled(): boolean {
  return readNavV3FlagsFromEnv().connectRulesV3Enabled;
}
