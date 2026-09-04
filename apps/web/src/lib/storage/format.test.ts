// story #2986(선생님 실사용 발견, 2026-08-24) — 이니셜 폴백 아바타가 어절별 첫 글자를
// 조합하면(라틴 이니셜 관례) 한글에서 우연히 비속어가 조립되는 실사고. 「시스템 발행」→
// 「시」+「발」=「시발」이 정확히 그 사례. 한글(비라틴) 다어절 이름은 첫 어절 첫 글자
// 1자만 쓰도록 고정 — 라틴 다어절(John Smith→JS)은 국제 관례대로 유지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initials, formatRelativeTime } from './format';
import { formatScheduledAt } from '@/components/content/schedule-format';

describe('initials() — 한글 다어절 이름은 어절 조합 없이 첫 어절 첫 글자만(#2986)', () => {
  it('「시스템 발행」이 「시발」이 아니라 「시」를 반환한다(실사고 재현 고정)', () => {
    expect(initials('시스템 발행')).toBe('시');
    expect(initials('시스템 발행')).not.toBe('시발');
  });

  it('한글 다어절 이름(성+이름 표기) 전반이 첫 어절 첫 글자만 반환한다', () => {
    expect(initials('미르코 페트로비치')).toBe('미');
    expect(initials('페드루 올리베이라')).toBe('페');
    expect(initials('디캄포 은두카쿠')).toBe('디');
  });

  it('한글 단일 어절 이름은 기존과 동일하게 첫 글자 1자를 반환한다(회귀 0)', () => {
    expect(initials('미르코')).toBe('미');
  });

  it('라틴 다어절 이름은 국제 관례대로 각 단어 첫 글자를 조합한다(회귀 0)', () => {
    expect(initials('John Smith')).toBe('JS');
  });

  it('라틴 단일 단어 이름은 기존과 동일하게 앞 2글자를 대문자로 반환한다(회귀 0)', () => {
    expect(initials('claude')).toBe('CL');
  });

  it('빈 이름은 물음표를 반환한다(회귀 0)', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

// story 3436(묶음 8) — 한국어 하드코딩 제거(Intl.RelativeTimeFormat, 선례
// team-activity-view.tsx `relativeTime`) + notification-bell `timeAgo` 흡수 통합 +
// 7일 초과는 §11-2 정본(formatScheduledAt, displayTimezone)으로 폴백.
describe('formatRelativeTime() — 로케일별 Intl.RelativeTimeFormat + 7일 초과 §11-2 폴백(story 3436 묶음 8)', () => {
  const NOW = new Date('2026-09-05T12:00:00Z').getTime();

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('⭐ko — 정확히 지금(diff=0)은 "지금"(舊 "방금"과 동형 의미, Intl 정본 표현)', () => {
    expect(formatRelativeTime(new Date(NOW).toISOString(), 'ko', 'UTC')).toBe('지금');
  });

  it('ko — 초/분/시간/어제 전부 Intl.RelativeTimeFormat 표준 granularity 그대로다(team-activity-view.tsx relativeTime과 동형, 舊 "방금" 뭉뚱그림 없음)', () => {
    expect(formatRelativeTime(new Date(NOW - 5000).toISOString(), 'ko', 'UTC')).toBe('5초 전');
    expect(formatRelativeTime(new Date(NOW - 5 * 60000).toISOString(), 'ko', 'UTC')).toBe('5분 전');
    expect(formatRelativeTime(new Date(NOW - 3 * 3600000).toISOString(), 'ko', 'UTC')).toBe('3시간 전');
    expect(formatRelativeTime(new Date(NOW - 24 * 3600000).toISOString(), 'ko', 'UTC')).toBe('어제');
  });

  it('en — 로케일을 그대로 반영한다(하드코딩 한국어 잔존 0)', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60000).toISOString(), 'en', 'UTC')).toBe('5 minutes ago');
  });

  it('⭐7일 이상은 상대시각이 아니라 §11-2 정본 절대시각(formatScheduledAt)으로 폴백한다', () => {
    const iso = new Date(NOW - 8 * 86400000).toISOString();
    expect(formatRelativeTime(iso, 'ko', 'UTC')).toBe(formatScheduledAt(iso, 'UTC').display);
    expect(formatRelativeTime(iso, 'ko', 'UTC')).not.toMatch(/일 전$/);
  });

  it('7일 폴백은 displayTimezone을 그대로 쓴다(§11-2 tz 정본과 동일 소스)', () => {
    const iso = new Date(NOW - 10 * 86400000).toISOString();
    expect(formatRelativeTime(iso, 'ko', 'Asia/Seoul')).toBe(formatScheduledAt(iso, 'Asia/Seoul').display);
  });

  it('잘못된 ISO는 빈 문자열(회귀 0, 舊 구현과 동형)', () => {
    expect(formatRelativeTime('not-a-date', 'ko', 'UTC')).toBe('');
  });
});
