import { describe, expect, it } from 'vitest';
import { resolveDisplayTimezone, toDateKey, formatScheduledAt, defaultCalendarRange, shiftCalendarRange } from './schedule-format';

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
    const { display, utcNote } = formatScheduledAt('2026-09-05T12:00:00Z', 'Asia/Seoul');
    expect(display).toMatch(/^09-05 21:00 /); // KST=UTC+9
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
