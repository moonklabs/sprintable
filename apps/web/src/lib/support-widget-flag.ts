// story #3260(지원v1 v1·2위젯) — 페드루 PO 조건부 승인(2026-08-31): 「UI는 있는데 서버가 없음」
// 결함 클래스(어제 사냥분) 재발 방지 — 항상 unavailable인 런처를 사용자 화면에 무조건 노출
// 하면 안 된다. lib/ee.ts(isEEEnabled)와 동일 컨벤션 — dev만 켠다(Support Gateway #f2a27d2a
// 착지·AC2/AC3 실측 통과 前까지 prod는 명시 false).
export function isSupportWidgetEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED === 'true';
}
