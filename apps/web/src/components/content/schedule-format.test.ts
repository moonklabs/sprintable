import { describe, expect, it } from 'vitest';
import { resolveDisplayTimezone, toDateKey, formatScheduledAt } from './schedule-format';

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
