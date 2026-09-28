// @vitest-environment node
// story #4289 — Accept-Language 판정 표(AC1). 옛 규칙(지원 목록 순서 en 먼저 · includes 부분 문자열)으로 되돌리면 ⭐줄이 RED.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, pickFromAcceptLanguage, resolveLocale } from './locale-negotiation';

describe('pickFromAcceptLanguage — 헤더 순서 + q값(story #4289)', () => {
  const table: Array<[string, 'en' | 'ko' | null]> = [
    ['ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7', 'ko'], // ⭐ PO 실측값 — 옛 규칙은 en
    ['en-US,en;q=0.9,ko;q=0.8', 'en'],
    ['ko', 'ko'],
    ['fr-FR,fr;q=0.9', null],
    ['en;q=0.5,ko;q=0.9', 'ko'], // ⭐ q값이 순서와 어긋남 — 옛 규칙은 en
    ['ko;q=0.8,en;q=0.8', 'ko'], // 같은 q면 헤더 앞쪽
    ['xen;q=0.9,ko;q=0.8', 'ko'], // ⭐ 다른 태그 속 글자 «en» — 옛 includes는 en
    ['KO-kr', 'ko'], // 대소문자 무관
    [' ko-KR , en ; q=0.5 ', 'ko'], // 공백
    ['en;q=0,ko;q=0.1', 'ko'], // q=0은 «원치 않음»
    ['en;q=0', null], // ⭐ q=0뿐이면 지원 언어가 있어도 고르지 않는다(기본값은 resolveLocale이)
    ['fr,en;q=0', null],
    ['en;q=abc,ko;q=0.2', 'ko'], // 깨진 q는 뺀다
    ['fr,*;q=0.5', DEFAULT_LOCALE], // *는 기본값
    ['', null],
  ];
  it.each(table)('%s → %s', (header, want) => {
    expect(pickFromAcceptLanguage(header)).toBe(want);
  });
  it('null · undefined → null', () => {
    expect(pickFromAcceptLanguage(null)).toBeNull();
    expect(pickFromAcceptLanguage(undefined)).toBeNull();
  });
});

describe('resolveLocale — 쿠키 → 헤더 → 기본값', () => {
  it('지원 쿠키가 있으면 헤더보다 앞', () => {
    expect(resolveLocale({ cookie: 'en', acceptLanguage: 'ko-KR,ko;q=0.9' })).toBe('en');
  });
  it('지원 밖 쿠키는 무시하고 헤더', () => {
    expect(resolveLocale({ cookie: 'fr', acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8' })).toBe('ko');
  });
  it('쿠키 · 헤더 모두 없거나 맞는 게 없으면 en', () => {
    expect(resolveLocale({})).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'fr-FR,fr;q=0.9' })).toBe('en');
  });
});
