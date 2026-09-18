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

// story #3422 B1(페드루 PO 재판정, 2026-09-04 12:4x) — 캘린더 range 경계를 UTC 자정으로
// 잡으면(구 defaultRange) KST 같은 양의 오프셋 tz에서 UTC 오늘 00:00=KST 오늘 09:00이라
// ① 첫 열(KST 오늘 00:00~08:59에 예약된 것)이 BE scheduled_from 필터에 안 걸려 빠지고
// ② 마지막 열도 같은 이유로 여드레째 이른 시각까지 걸려 8열(부분 표본)이 된다. 경계는
// «display tz의 자정»이어야 그리드 열 키(toDateKey, 같은 tz)와 어긋나지 않는다 —
// 이 파일이 tz↔UTC 변환의 유일한 출처(resolveDisplayTimezone·toDateKey와 동형 원칙).

/** utcInstant 시점에 tz가 UTC보다 얼마나 앞서 있는지(ms). DST 등으로 절기마다 바뀔 수
 * 있어 고정 상수로 못 쓴다 — 매번 그 시각 기준으로 다시 잰다. */
function tzOffsetMs(utcInstant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcInstant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // hour12:false에서 자정이 '24'로 나오는 로케일 방어(en-US는 보통 '00'이지만 방어적으로).
  const asUtcIfSameWallClock = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  // Intl.formatToParts는 밀리초를 안 준다 — utcInstant를 ms 그대로 빼면(예: .999) 초 단위로
  // 반올림된 asUtcIfSameWallClock(.000)과 최대 999ms 가짜 오프셋이 섞여 날짜가 하루
  // 밀리는 사고가 났다(실측, B1 회귀). 초 단위로 내림해 같은 정밀도끼리 비교한다 — tz
  // 오프셋 자체는 초 단위 이하로 안 바뀌므로 이 반올림은 결과에 영향이 없다.
  const utcInstantWholeSecond = Math.floor(utcInstant.getTime() / 1000) * 1000;
  return asUtcIfSameWallClock - utcInstantWholeSecond;
}

/** dateKey(YYYY-MM-DD)의 그 tz 벽시계 hh:mm:ss.mmm을 UTC ISO로 변환. addCalendarDays로
 * 만든 날짜 키와 짝지어 «그 tz에서의 자정/자정 직전»을 정확히 만든다.
 *
 * 유나 기록(2026-09-04, blocking 아님) — 오프셋 계산이 1회 통과다(utcGuess로 오프셋을
 * 한 번 구해 그대로 뺀다). 자정 그 자체에 DST/표준시 전환이 걸리는 시간대(예:
 * America/Santiago)에서는 hh=0 근방의 utcGuess가 전환 전/후 어느 쪽 오프셋을 잡느냐에
 * 따라 경계가 최대 한 시간 어긋날 수 있다. 지금 테스트가 고정하는 네 시간대(KST·UTC·
 * Honolulu·LA)는 전환 시각이 자정이 아니라 이 오차의 영향을 안 받는다 — 조직 시간대
 * 기능이 열려 자정 전환 tz가 실제로 들어올 때 재검토 대상으로 남겨 둔다. */
function zonedWallClockToIso(dateKey: string, hh: number, mm: number, ss: number, ms: number, tz: string): string {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const utcGuess = Date.UTC(y, (mo ?? 1) - 1, d, hh, mm, ss, ms);
  const offset = tzOffsetMs(new Date(utcGuess), tz);
  return new Date(utcGuess - offset).toISOString();
}

/** dateKey에 달력일 기준으로 n일을 더한다(시각 정보 없는 순수 날짜 산술 — DST·tz 무관,
 * B1③ shiftRange가 ms 산술로 DST tz에서 하루 밀리던 것의 근본 수정 재료). */
function addCalendarDays(dateKey: string, days: number): string {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const noon = Date.UTC(y, (mo ?? 1) - 1, d, 12); // 정오 기준 — 자정 근처 반올림 오차 회피.
  const shifted = new Date(noon + days * 86400000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** 캘린더 기본 range — tz 기준 «오늘 00:00 ~ +6일 23:59:59.999»(7일). 그리드 열 키
 * (toDateKey)와 같은 tz 산술을 써야 정확히 7열이 선다(B1②). */
export function defaultCalendarRange(tz: string, now: Date = new Date()): { from: string; to: string } {
  const todayKey = toDateKey(now.toISOString(), tz);
  const endKey = addCalendarDays(todayKey, 6);
  return {
    from: zonedWallClockToIso(todayKey, 0, 0, 0, 0, tz),
    to: zonedWallClockToIso(endKey, 23, 59, 59, 999, tz),
  };
}

/** range를 tz 기준 달력일 단위로 deltaDays만큼 이동(B1③ — ms 산술 대신 날짜 키 산술이라
 * DST 전환일을 넘어가도 열이 안 밀린다). */
export function shiftCalendarRange(
  range: { from: string; to: string }, tz: string, deltaDays: number,
): { from: string; to: string } {
  const fromKey = addCalendarDays(toDateKey(range.from, tz), deltaDays);
  const toKey = addCalendarDays(toDateKey(range.to, tz), deltaDays);
  return {
    from: zonedWallClockToIso(fromKey, 0, 0, 0, 0, tz),
    to: zonedWallClockToIso(toKey, 23, 59, 59, 999, tz),
  };
}
