import { describe, expect, it } from 'vitest';
import { resolveDisplayTimezone, toDateKey, formatScheduledAt, defaultCalendarRange, shiftCalendarRange, todayDateKey, defaultPastDaysDateRange, dateKeysToInstants, shiftDayStartIso } from './schedule-format';

// story #3422(doc §11-2, 페드루 PO 지적 2026-09-04 08:57Z) — 그룹핑과 표기가 같은 tz를
// 써야 한다. 21:30 KST(=UTC 12:30, 같은 날)와 09:00 KST(=UTC 전날 24:00 부근)를 각각
// KST/UTC로 재면 날짜가 갈리는 경계 표본으로 pin한다.
describe('toDateKey', () => {
  it('KST 자정 넘김 경계 — UTC로는 전날, KST로는 당일', () => {
    // 2026-09-05 09:00 KST === 2026-09-05 00:00 UTC(자정 정각) — 이 값 자체는 안 갈리지만
    // 그보다 이른 UTC 값(전날 저녁)이 KST로는 다음날 새벽이 되는 경계를 쓴다.
    const iso = '2026-09-04T16:00:00Z'; // KST(UTC+9) = 2026-09-05 01:00
    expect(toDateKey(iso, 'UTC')).toBe('2026-09-04');
    expect(toDateKey(iso, 'Asia/Seoul')).toBe('2026-09-05');
  });

  it('타임존이 같으면 같은 날짜 키를 낸다(회귀 방지)', () => {
    expect(toDateKey('2026-09-05T03:00:00Z', 'UTC')).toBe('2026-09-05');
  });
});

describe('formatScheduledAt', () => {
  it('MM-DD HH:mm {TZ} 형태로 낸다(doc §11-2 정본 형태) + UTC 보조줄', () => {
    // story #4280 — 표기는 보는 사람 시간대에 따라 달라져(같은 오프셋이면 생략) 실행 기계의 TZ에 기대지 않게 보는 사람을 «모름»(null)으로 고정.
    const { display, utcNote } = formatScheduledAt('2026-09-05T12:00:00Z', 'Asia/Seoul', null);
    expect(display).toBe('09-05 21:00 GMT+9'); // KST=UTC+9
    expect(utcNote).toBe('= 09-05 12:00 UTC');
  });
});

// story #3422 ②-d(페드루 PO 계약 전달 2026-09-04 10:44Z, story #46da6450) — 조직
// timezone 필드 有/無 두 갈래. BE 머지 前엔 undefined가 온다(필드 자체가 없음).
// story #3422 B1(페드루 PO 재판정, 2026-09-04 12:1x~4x) — 구 defaultRange()가 UTC
// 자정으로 경계를 잡아 KST 같은 양의 오프셋 tz에서 ①첫 열(그 tz 오늘 00:00~08:59)이
// BE 필터에 안 걸려 빠지고 ②끝 열도 같은 이유로 하루 더 걸려 8열(부분 표본)이 됐다.
// UTC 하나만 검사하면 이 결함 자체가 통과해 버린다(UTC에서는 tz 자정=UTC 자정이라
// 증상이 안 남는다) — 양의 오프셋(KST)·기준(UTC)·음의 오프셋(Honolulu, DST 없음) 셋
// 전부에서 정확히 7열(오늘..+6일)·자정 경계를 pin한다(④).
function wallClockHms(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

describe('defaultCalendarRange — B1 진리표(양의 오프셋·기준·음의 오프셋)', () => {
  const now = new Date('2026-09-04T12:00:00Z'); // 세 tz 전부에서 캘린더 날짜가 '2026-09-04'로 같다(실측 확認).

  it.each(['Asia/Seoul', 'UTC', 'Pacific/Honolulu'])(
    '%s — 열 정확히 7개(오늘..+6일)·경계는 그 tz의 자정/자정 직전',
    (tz) => {
      const range = defaultCalendarRange(tz, now);
      expect(toDateKey(range.from, tz)).toBe('2026-09-04');
      expect(toDateKey(range.to, tz)).toBe('2026-09-10'); // +6일 = 오늘 포함 7일
      expect(wallClockHms(range.from, tz)).toBe('00:00:00');
      expect(wallClockHms(range.to, tz)).toBe('23:59:59');
    },
  );
});

// story #3422 B1③ — 구 shiftRange는 고정 WEEK_MS(7×86400000ms)로 이동해 DST 전환일을
// 넘으면 한 시간이 밀려 tz 자정 경계가 어긋난다. 날짜 키 기반 이동(addCalendarDays)은
// DST 전환 자체를 모르고 달력일만 세므로 안 밀린다 — America/Los_Angeles 2026년 봄
// 전환(3/8 02:00 → 03:00, 실측 미국 규칙)을 걸치는 range로 pin.
describe('shiftCalendarRange — B1③ DST 경계(America/Los_Angeles 2026-03-08 전환)', () => {
  it('⭐DST 전환을 걸치는 range를 +7일 이동해도 경계가 정확히 그 tz 자정으로 유지된다', () => {
    const tz = 'America/Los_Angeles';
    const beforeDst = defaultCalendarRange(tz, new Date('2026-03-04T12:00:00Z')); // 2026-03-04~03-10, 3/8 전환 포함
    const shifted = shiftCalendarRange(beforeDst, tz, 7);
    expect(toDateKey(shifted.from, tz)).toBe('2026-03-11');
    expect(toDateKey(shifted.to, tz)).toBe('2026-03-17');
    expect(wallClockHms(shifted.from, tz)).toBe('00:00:00');
    expect(wallClockHms(shifted.to, tz)).toBe('23:59:59');
  });

  it('이전 주 이동도 대칭으로 정확하다(-7일)', () => {
    const tz = 'America/Los_Angeles';
    const range = defaultCalendarRange(tz, new Date('2026-03-11T12:00:00Z'));
    const shifted = shiftCalendarRange(range, tz, -7);
    expect(toDateKey(shifted.from, tz)).toBe('2026-03-04');
    expect(toDateKey(shifted.to, tz)).toBe('2026-03-10');
  });
});

describe('resolveDisplayTimezone — 조직 tz 有/無 두 갈래', () => {
  it('⭐조직 timezone이 있으면 그것을 쓰고 isOrgTimezone=true', () => {
    expect(resolveDisplayTimezone('Asia/Seoul')).toEqual({ tz: 'Asia/Seoul', isOrgTimezone: true });
  });

  it('⭐조직 timezone이 null이면(BE 필드는 있지만 조직이 안 정함) 브라우저 폴백, isOrgTimezone=false', () => {
    const result = resolveDisplayTimezone(null);
    expect(result.isOrgTimezone).toBe(false);
    expect(result.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('조직 timezone이 undefined면(BE 머지 前, 필드 자체가 없음) null과 동형 — 브라우저 폴백', () => {
    const result = resolveDisplayTimezone(undefined);
    expect(result.isOrgTimezone).toBe(false);
    expect(result.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('인자를 아예 안 주면(기존 호출부, 하위 호환) 브라우저 폴백', () => {
    const result = resolveDisplayTimezone();
    expect(result.isOrgTimezone).toBe(false);
  });
});

// story #4280 — 날짜 입력칸 기본값(«오늘» · 최근 N일)과 날짜 키 → 조회 경계. 경계 시각 넷(KST 00:30 · 08:59 · 09:00 · UTC 자정 전후).
describe('todayDateKey · defaultPastDaysDateRange — 표시 시간대의 «오늘»(story #4280)', () => {
  const cases: Array<{ label: string; utc: string; kst: string; utcDate: string }> = [
    { label: 'KST 00:30 (UTC 전날 15:30)', utc: '2026-09-24T15:30:00Z', kst: '2026-09-25', utcDate: '2026-09-24' },
    { label: 'KST 08:59 (UTC 전날 23:59 · UTC 자정 직전)', utc: '2026-09-24T23:59:00Z', kst: '2026-09-25', utcDate: '2026-09-24' },
    { label: 'KST 09:00 (UTC 00:00 · UTC 자정)', utc: '2026-09-25T00:00:00Z', kst: '2026-09-25', utcDate: '2026-09-25' },
    { label: '민 기기 실측 KST 02:49', utc: '2026-09-24T17:49:00Z', kst: '2026-09-25', utcDate: '2026-09-24' },
  ];
  for (const c of cases) {
    it(`${c.label} → Asia/Seoul 오늘 ${c.kst} · UTC 오늘 ${c.utcDate}`, () => {
      expect(todayDateKey('Asia/Seoul', new Date(c.utc))).toBe(c.kst);
      expect(todayDateKey('UTC', new Date(c.utc))).toBe(c.utcDate);
    });
  }

  it('⭐KST 02:49 기본 7일 = 9/18 ~ 9/25(UTC 날짜 자르기였던 예전 값 9/17 ~ 9/24가 아님)', () => {
    expect(defaultPastDaysDateRange('Asia/Seoul', 7, new Date('2026-09-24T17:49:00Z'))).toEqual({ from: '2026-09-18', to: '2026-09-25' });
  });

  it('음의 오프셋(LA) — UTC가 이미 다음 날이어도 LA 날짜', () => {
    // 2026-09-25T03:00Z = LA 9/24 20:00(PDT)
    expect(defaultPastDaysDateRange('America/Los_Angeles', 7, new Date('2026-09-25T03:00:00Z'))).toEqual({ from: '2026-09-17', to: '2026-09-24' });
  });

  it('달 · 해 경계를 달력일로 넘는다', () => {
    expect(defaultPastDaysDateRange('Asia/Seoul', 7, new Date('2026-01-02T01:00:00Z'))).toEqual({ from: '2025-12-26', to: '2026-01-02' });
  });
});

describe('dateKeysToInstants — 날짜 키 → 표시 시간대 자정 · 자정 직전의 UTC ISO(story #4280)', () => {
  it('⭐Asia/Seoul: 9/18 00:00 KST = 9/17 15:00Z · 9/25 23:59:59.999 KST = 9/25 14:59:59.999Z', () => {
    expect(dateKeysToInstants('2026-09-18', '2026-09-25', 'Asia/Seoul')).toEqual({
      from: '2026-09-17T15:00:00.000Z',
      to: '2026-09-25T14:59:59.999Z',
    });
  });

  it('UTC: 오프셋 0', () => {
    expect(dateKeysToInstants('2026-09-18', '2026-09-25', 'UTC')).toEqual({
      from: '2026-09-18T00:00:00.000Z',
      to: '2026-09-25T23:59:59.999Z',
    });
  });

  it('LA(PDT −7)', () => {
    expect(dateKeysToInstants('2026-09-18', '2026-09-24', 'America/Los_Angeles')).toEqual({
      from: '2026-09-18T07:00:00.000Z',
      to: '2026-09-25T06:59:59.999Z',
    });
  });

  it('빈 키는 null(날짜 칸을 비운 경우 · 경계 없이 조회)', () => {
    expect(dateKeysToInstants('', '', 'Asia/Seoul')).toEqual({ from: null, to: null });
  });
});

// story #4280 AC3(유나 판정) — 시간대 표기: 보는 사람과 그 시각에 같은 오프셋이면 생략 · 다르면 shortOffset(«GMT+9»). 이름 아닌 오프셋 비교.
describe('formatScheduledAt 시간대 표기 — 같은 오프셋이면 생략 · 다르면 shortOffset(story #4280)', () => {
  const SUMMER = '2026-09-05T12:00:00Z'; // LA PDT(−7) · Phoenix MST(−7)
  const WINTER = '2026-01-15T12:00:00Z'; // LA PST(−8) · Phoenix MST(−7)
  const cases: Array<[string, string, string, string | null, string]> = [
    ['서울 표시 · 서울 사람 → 생략', SUMMER, 'Asia/Seoul', 'Asia/Seoul', '09-05 21:00'],
    ['⭐서울 표시 · 도쿄 사람(이름 달라도 같은 +9) → 생략', SUMMER, 'Asia/Seoul', 'Asia/Tokyo', '09-05 21:00'],
    ['⭐서울 표시 · LA 사람 → GMT+9', SUMMER, 'Asia/Seoul', 'America/Los_Angeles', '09-05 21:00 GMT+9'],
    ['⭐LA 표시 · 서울 사람 → GMT-7(«PDT» 아님 · 로케일 무관)', SUMMER, 'America/Los_Angeles', 'Asia/Seoul', '09-05 05:00 GMT-7'],
    ['⭐LA 표시 · 피닉스 사람 · 여름(둘 다 −7) → 생략', SUMMER, 'America/Los_Angeles', 'America/Phoenix', '09-05 05:00'],
    ['⭐LA 표시 · 피닉스 사람 · 겨울(−8 vs −7) → GMT-8', WINTER, 'America/Los_Angeles', 'America/Phoenix', '01-15 04:00 GMT-8'],
    ['30분 오프셋 — 콜카타 표시 · 서울 사람 → GMT+5:30', SUMMER, 'Asia/Kolkata', 'Asia/Seoul', '09-05 17:30 GMT+5:30'],
    ['UTC 표시 · 서울 사람 → GMT', SUMMER, 'UTC', 'Asia/Seoul', '09-05 12:00 GMT'],
    ['⭐보는 사람 모름(서버 렌더 · null) → 항상 붙임', SUMMER, 'Asia/Seoul', null, '09-05 21:00 GMT+9'],
  ];
  for (const [label, iso, tz, viewer, expected] of cases) {
    it(label, () => {
      expect(formatScheduledAt(iso, tz, viewer).display).toBe(expected);
    });
  }

  it('UTC 보조줄은 그대로', () => {
    expect(formatScheduledAt(SUMMER, 'Asia/Seoul', 'Asia/Seoul').utcNote).toBe('= 09-05 12:00 UTC');
  });
});

// story #4280(까디르 검수 P3) — 팀 활동 «더 보기»가 고정 168시간으로 과거를 밀어 서머타임 주엔 자정이 한 시간 어긋났다.
describe('shiftDayStartIso — 달력일 단위로 그 tz의 자정', () => {
  it('⭐LA 서머타임 시작 주: 3/15 00:00 PDT에서 7일 전 = 3/8 00:00 PST(168시간 전이면 3/7 23:00 PST)', () => {
    const start = '2026-03-15T07:00:00.000Z'; // 3/15 00:00 PDT(−7)
    expect(shiftDayStartIso(start, 'America/Los_Angeles', -7)).toBe('2026-03-08T08:00:00.000Z'); // 3/8 00:00 PST(−8)
    expect(new Date(Date.parse(start) - 7 * 86_400_000).toISOString()).toBe('2026-03-08T07:00:00.000Z'); // 옛 계산 = 3/7 23:00 PST
  });
  it('서머타임 없는 KST는 168시간과 같다', () => {
    expect(shiftDayStartIso('2026-09-17T15:00:00.000Z', 'Asia/Seoul', -7)).toBe('2026-09-10T15:00:00.000Z');
  });
});

