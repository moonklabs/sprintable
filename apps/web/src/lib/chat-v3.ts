/**
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N) — `/chat` v3 셸은 기존 `/chats`를
 * 전혀 안 건드리므로 `today-v3.ts::isTodayV3Enabled`와 같은 순수 env 플래그
 * 패턴을 그대로 재사용(새 플래그 관례 발명 0).
 */
export function isChatV3Enabled(): boolean {
  return process.env['CHAT_V3_ENABLED'] === 'true';
}
