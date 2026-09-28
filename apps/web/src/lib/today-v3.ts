/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N) — `/today` v3 셸은 기존 nav·화면을
 * 전혀 안 건드리므로(「셸 변경은 흡수 화면 착지 뒤」 규율) 조직 설정이 아니라 순수
 * env 플래그로 게이트한다 — `internal-dogfood.ts::isInternalDogfoodEnabled`와 같은
 * 모양(그라운딩 결론, 페드루 PO 確認 2026-09-16 15:36Z) — 새 플래그 관례 발명 0.
 *
 * story #4017 CHANGES 2(rebase 시점 정렬, 2026-09-22) — TODAY_V3_ENABLED를 직접
 * process.env로 읽던 것을 nav-v3-flags-server.ts(readNavV3FlagsFromEnv, 단일소스)로
 * 위임 — env 이름 3개는 그 파일 한 곳에서만 읽는다는 이 카드 자신의 가드를 따른다.
 */
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';

export function isTodayV3Enabled(): boolean {
  return readNavV3FlagsFromEnv().todayV3Enabled;
}
