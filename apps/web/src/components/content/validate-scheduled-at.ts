// story #3422 ②-d(doc §11 T8, BE backend/app/routers/channel_posts.py::
// _scheduled_at_must_be_tz_aware_future 실물 규칙 그대로) — 상신 시 scheduled_at 입력
// 검증. BE 규칙 둘: ①tz 정보 필수(naive면 422) ②현재 시각 이후여야 함(과거면 422,
// "예약이 즉시 도래해 버려 사용자 의도와 어긋난다"는 BE 주석 그대로 — cron 자가치유
// 대신 애초에 요청을 안 받는 게 정직하다는 BE 판단).
//
// ⚠️경계 — <input type="datetime-local">의 값(예: "2026-09-05T14:30")은 그 자체로 tz
// 정보가 없다. 이 검증기는 그 값을 "브라우저 자신의 로컬 tz"로 해석해 UTC ISO로
// 바꾼다(new Date(localValue)는 항상 브라우저 로컬 tz로 해석하는 JS 표준 동작) —
// schedule-format.ts::resolveDisplayTimezone()의 폴백과 정확히 같은 축(브라우저 tz).
// 조직 타임존이 브라우저와 달라지는 순간(BE 조직 tz 필드 착지 뒤) 이 변환 자체를
// 제대로 된 tz 변환 라이브러리로 바꿔야 한다 — 지금은 그 필드가 없어(그라운딩 확認,
// story #3422 ②-a 커밋 참고) 범위 밖으로 명시해 둔다.
export type ScheduledAtValidation =
  | { valid: true; iso: string }
  | { valid: false; reason: 'past' | 'invalid' };

export function validateScheduledAt(localValue: string, now: Date = new Date()): ScheduledAtValidation {
  if (!localValue) return { valid: false, reason: 'invalid' };
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) return { valid: false, reason: 'invalid' };
  if (date.getTime() <= now.getTime()) return { valid: false, reason: 'past' };
  return { valid: true, iso: date.toISOString() };
}
