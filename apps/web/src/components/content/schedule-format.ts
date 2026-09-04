// story #3422(doc §11-2) — 예약 시각은 "조직 타임존"으로 표기하고 그 이름을 값 옆에
// 적는다. 그라운딩(2026-09-04) — organization 모델·라우터 전체를 grep했지만 조직
// 타임존 필드 자체가 없었다(0건, 당시 기준). ⇒ 브라우저 타임존으로 폴백하고 "브라우저
// 시간대"임을 표기한다(지어내지 않는다 — 조직이 설정한 값인 것처럼 보이면 안 된다).
//
// 페드루 PO 계약 전달(2026-09-04 10:44Z, story #46da6450 — organizations.timezone
// BE 착수) — 조직 응답에 IANA `timezone`(string|null) 필드가 실릴 예정. 착지 전에도
// 이 함수 하나가 소스를 결정하는 유일한 지점이 되도록 파라미터를 미리 받아 둔다
// (BE 머지 전엔 그 필드 자체가 없으니 호출부가 optional chaining으로 undefined/null을
// 넘긴다 — 이 함수 안에서는 null과 undefined를 구분하지 않는다, 둘 다 "없다").
export function resolveDisplayTimezone(orgTimezone?: string | null): { tz: string; isOrgTimezone: boolean } {
  // 페드루 PO 지적(2026-09-04 08:57Z) — 그룹핑(캘린더 격자 날짜 키)과 표기(사람이 보는
  // 시각 문자열)가 서로 다른 tz를 쓰면 21:30 KST 예약이 UTC 격자에선 전날 칸에 선다.
  // 이 함수 하나가 둘의 유일한 tz 출처다 — toDateKey·formatScheduledAt이 이 값만 쓴다.
  if (orgTimezone) return { tz: orgTimezone, isOrgTimezone: true };
  try {
    return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, isOrgTimezone: false };
  } catch {
    return { tz: 'UTC', isOrgTimezone: false };
  }
}

/** 캘린더 격자의 날짜 열 키(YYYY-MM-DD, 주어진 tz 기준) — formatScheduledAt과 같은
 * tz를 받아야 그룹핑과 표기가 어긋나지 않는다(위 docstring 그대로). */
export function toDateKey(iso: string, tz: string): string {
  // Intl.DateTimeFormat의 'en-CA' 로케일이 YYYY-MM-DD를 그대로 낸다(en-CA의 표준 단문
  // 날짜 포맷) — 직접 문자열 조립보다 tz 변환을 안전하게 위임한다.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** doc §11-2 정본 형태 — "MM-DD HH:mm {TZ}" + UTC 보조줄. tz가 브라우저 폴백이면
 * isOrgTimezone=false로 소비부가 "브라우저 시간대" 안내를 따로 붙일 수 있게 한다. */
export function formatScheduledAt(iso: string, tz: string): { display: string; utcNote: string } {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const display = `${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
  const utcNote = `= ${iso.slice(5, 16).replace('T', ' ')} UTC`;
  return { display, utcNote };
}
