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

// 페드루 PO 지적(2026-09-04 10:49Z) — 클라 검증을 통과해도 입력→상신 사이 시각이
// 흘러 과거가 되거나(느린 네트워크·다이얼로그 오래 열어둠) 클라-서버 시계 차이가
// 나면 서버(pydantic field_validator, backend/app/routers/channel_posts.py)가 422로
// 거부하는 실제 경로가 있다. FastAPI 기본 검증 오류 shape(`{detail: [{loc, msg, type}]}`
// — 이 프로젝트가 쓰는 앱 오류 shape `{detail: {code, message}}`와 다르다, api-error.ts
// 참고)를 그대로 노출하면 "Value error, scheduled_at은…" 같은 내부 문구가 사용자에게
// 뜬다 — 사람 문장 1개로 접는다. 이 shape가 아니면(다른 종류 422/오류) null을 내
// 소비부가 다른 오류 처리로 넘기게 한다.
export function parseScheduledAtServerError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return null;
  const hit = detail.find((d) => Array.isArray((d as { loc?: unknown[] })?.loc) && (d as { loc: unknown[] }).loc.includes('scheduled_at'));
  return hit ? 'past_or_invalid' : null;
}

export function validateScheduledAt(localValue: string, now: Date = new Date()): ScheduledAtValidation {
  if (!localValue) return { valid: false, reason: 'invalid' };
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) return { valid: false, reason: 'invalid' };
  if (date.getTime() <= now.getTime()) return { valid: false, reason: 'past' };
  return { valid: true, iso: date.toISOString() };
}
