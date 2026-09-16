/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N) — `/today` v3 셸은 기존 nav·화면을
 * 전혀 안 건드리므로(「셸 변경은 흡수 화면 착지 뒤」 규율) 조직 설정이 아니라 순수
 * env 플래그로 게이트한다 — `internal-dogfood.ts::isInternalDogfoodEnabled`와 같은
 * 모양(그라운딩 결론, 페드루 PO 確認 2026-09-16 15:36Z) — 새 플래그 관례 발명 0.
 */
export function isTodayV3Enabled(): boolean {
  return process.env['TODAY_V3_ENABLED'] === 'true';
}
