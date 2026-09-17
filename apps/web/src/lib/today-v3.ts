// story #3962(E-UX-OVERHAUL·「오늘」) — TODAY_V3_ENABLED 플래그 헬퍼. #3983은
// base=develop(스택 아님)이라 이 파일이 develop에 아직 없다 — #3962의 내용
// 그대로 복제(발명 0, 그 브랜치 착지 뒤 rebase 1회로 흡수).
export function isTodayV3Enabled(): boolean {
  return process.env['TODAY_V3_ENABLED'] === 'true';
}
