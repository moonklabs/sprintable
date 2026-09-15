import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNewLowercaseWordViolations,
  computeStaleLowercaseWordBaseline,
  loadKoJson,
  LOWERCASE_WORD_ALLOWLIST,
  LOWERCASE_WORD_BASELINE,
  lowercaseWordRefKey,
  scanKoLowercaseWords,
  scanKoValues,
  scanKoWholeValues,
} from './verify-no-ascii-token-in-ko-value';

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');

// story #3926(§⑤ 낱말 드리프트 축3) — 「무관 PR no-op」·실 ko.json 양성대조·실 트리
// 전량검증을 전용 파일로 분리(페드루 PO 지시, 2026-09-15). 공유 가드 자기테스트 파일
// (verify-no-ascii-token-in-ko-value.test.ts)엔 순수 함수 단위 테스트(합성 fixture)만
// 남기고, 이 파일엔 이 스토리가 소유한 실 ko.json 대조·회귀 증명만 둔다 — 같은 자리에
// 여러 §⑤ PR이 append하며 반복 충돌하는 클래스, 실 키를 표본으로 써 다른 PR이 그 값을
// 고치면 RED가 나는 클래스 둘 다 구조적으로 피한다.

describe('computeNewLowercaseWordViolations — 무관 PR no-op 표본(합성 fixture, 실 키 0)', () => {
  it('한글+영단어 혼입이 전혀 없는 값들은 GREEN(exit 0)', () => {
    const fixture = { a: { x: '순 한국어 값' }, b: { y: 'Pure ASCII' } };
    const refs = scanKoLowercaseWords(fixture);
    const violations = computeNewLowercaseWordViolations(refs, LOWERCASE_WORD_ALLOWLIST, LOWERCASE_WORD_BASELINE);
    expect(violations).toEqual([]);
  });
});

describe('실 파일 실측 양성대조 — ko.json(usage.noAlerts 되돌리기, 축3 갭 봉쇄 증명)', () => {
  const original = loadKoJson(KO_JSON_PATH);

  it('전제: 원본은 usage.noAlerts에서 축1·2·3 전부 위반 0(이미 한국어 — story #3926 ①전환)', () => {
    const usageNs = original.usage as Record<string, unknown>;
    expect(usageNs.noAlerts).toBe('이번 달 기록된 결제 알림이 없어요.');
    expect(scanKoValues(original).some((r) => r.key === 'usage.noAlerts')).toBe(false);
    expect(scanKoWholeValues(original).some((r) => r.key === 'usage.noAlerts')).toBe(false);
    expect(scanKoLowercaseWords(original).some((r) => r.key === 'usage.noAlerts')).toBe(false);
  });

  it('되돌리면(billing alert) 축1(CAPS)·축2(전체값) 둘 다 여전히 GREEN — 한글 섞인 값은 구조적으로 못 본다', () => {
    const usageNs = original.usage as Record<string, unknown>;
    const mutated = { ...original, usage: { ...usageNs, noAlerts: '이번 달 기록된 billing alert가 없어요.' } };
    expect(scanKoValues(mutated).some((r) => r.key === 'usage.noAlerts')).toBe(false);
    expect(scanKoWholeValues(mutated).some((r) => r.key === 'usage.noAlerts')).toBe(false);
  });

  it('되돌리면(billing alert) 축3(소문자 혼입)은 RED — 갭이 봉쇄됐다(story #3926 처방)', () => {
    const usageNs = original.usage as Record<string, unknown>;
    const mutated = { ...original, usage: { ...usageNs, noAlerts: '이번 달 기록된 billing alert가 없어요.' } };
    const refs = scanKoLowercaseWords(mutated);
    const violations = computeNewLowercaseWordViolations(refs, LOWERCASE_WORD_ALLOWLIST, LOWERCASE_WORD_BASELINE);
    expect(violations.map((r) => r.key)).toContain('usage.noAlerts');
    expect(violations.filter((r) => r.key === 'usage.noAlerts').map((r) => r.word).sort()).toEqual(['alert', 'billing']);
  });
});

describe('scanKoLowercaseWords — story #3926(실 트리 실행)', () => {
  it('실 ko.json — LOWERCASE_WORD_ALLOWLIST+LOWERCASE_WORD_BASELINE과 정확히 일치(신규 0·stale 0)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoLowercaseWords(koJson);
    expect(refs.length).toBeGreaterThan(0);
    const newViolations = computeNewLowercaseWordViolations(refs, LOWERCASE_WORD_ALLOWLIST, LOWERCASE_WORD_BASELINE);
    const staleBaseline = computeStaleLowercaseWordBaseline(
      refs.filter((r) => !LOWERCASE_WORD_ALLOWLIST.has(lowercaseWordRefKey(r))),
      LOWERCASE_WORD_BASELINE,
    );
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });
});
