/**
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N) — `/chat` v3 셸은 기존 `/chats`를
 * 전혀 안 건드리므로 `today-v3.ts::isTodayV3Enabled`와 같은 순수 env 플래그
 * 패턴을 그대로 재사용(새 플래그 관례 발명 0).
 *
 * story #4017 CHANGES 2(rebase 시점 정렬, 2026-09-22) — CHAT_V3_ENABLED를 직접
 * process.env로 읽던 것을 nav-v3-flags-server.ts(readNavV3FlagsFromEnv, 단일소스)로
 * 위임 — env 이름 3개는 그 파일 한 곳에서만 읽는다는 이 카드 자신의 가드를 따른다.
 */
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';

export function isChatV3Enabled(): boolean {
  return readNavV3FlagsFromEnv().chatV3Enabled;
}
