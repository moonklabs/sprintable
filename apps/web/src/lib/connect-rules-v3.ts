/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — 「오늘」(#3962)·「대화」(#3972) 선례와
 * 같은 모양의 env 플래그 게이트(`isTodayV3Enabled`/`isChatV3Enabled` 동형) — 새 플래그
 * 관례 발명 0.
 */
export function isConnectRulesV3Enabled(): boolean {
  return process.env['CONNECT_RULES_V3_ENABLED'] === 'true';
}
