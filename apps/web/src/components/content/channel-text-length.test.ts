import { describe, test, expect } from 'vitest';
import { channelTextLength } from './channel-text-length';

// story #3402(페드루 PO 지시 2026-09-04 01:43Z) — 아래 CANONICAL_SAMPLE은 디디군 BE
// 스토리와 공유하는 같은 표본(양쪽 pin이 같은 뜻을 가지게) — 페드루가 준 실측값(코드포인트
// 27·UTF-16 30)을 python len()·JS 양쪽으로 직접 재확인 후 반영(둘 다 정확히 일치).
const CANONICAL_SAMPLE = '에이전트 여섯이 스프린트 하나를 😀 돌린다 👩‍💻';

describe('channelTextLength (story #3402, doc §3-1 — 서버 len()과 같은 단위)', () => {
  test('일반 ASCII — .length와 동일', () => {
    expect(channelTextLength('hello')).toBe(5);
  });

  test('한글 — 코드포인트=UTF-16 유닛(서프로게이트 없음)이라 .length와 동일', () => {
    expect(channelTextLength('안녕하세요')).toBe(5);
  });

  test('⭐서프로게이트 페어 이모지(😀) — .length=2인데 channelTextLength=1(Python len()과 일치)', () => {
    expect('😀'.length).toBe(2); // 대조 — UTF-16 유닛 수(틀린 기준)
    expect(channelTextLength('😀')).toBe(1);
  });

  test('⭐ZWJ 결합 이모지(👩‍💻) — .length=5인데 channelTextLength=3(여자+ZWJ+노트북, 각 코드포인트를 따로 센다)', () => {
    expect('👩‍💻'.length).toBe(5); // 대조
    expect(channelTextLength('👩‍💻')).toBe(3);
  });

  // 페드루·디디 공유 표본(2026-09-04 01:43Z) — «이 문장이 27이어야 하고 30이면 RED».
  // 서버(Python len())·BE 스토리 테스트와 같은 문장·같은 기대값을 쓴다 — FE/BE 두 쪽이
  // 각자 다른 문장으로 "코드포인트 카운팅이 맞다"를 증명하면 두 증명이 서로를 검증 못한다.
  test('⭐공유 표본 — UTF-16 30·코드포인트 27, channelTextLength는 27을 낸다(30이면 회귀)', () => {
    expect(CANONICAL_SAMPLE.length).toBe(30); // 대조 — UTF-16 유닛 수(틀린 기준)
    expect(channelTextLength(CANONICAL_SAMPLE)).toBe(27);
  });

  test('빈 문자열', () => {
    expect(channelTextLength('')).toBe(0);
  });
});
