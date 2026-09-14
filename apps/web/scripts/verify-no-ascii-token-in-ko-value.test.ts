import { describe, expect, it } from 'vitest';
import { ALLOWLIST, computeNewViolations, computeStaleBaseline, loadBaseline, loadKoJson, refKey, scanKoValues } from './verify-no-ascii-token-in-ko-value';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ascii-token-in-ko-value-baseline.json');

describe('scanKoValues — story #3880 AC2(b) 셀프테스트', () => {
  it('⭐값 안 대문자 2자+ 토큰 → RED(토큰마다 각각 — "KNOWLEDGE"·"BASE" 2건)', () => {
    const fixture = { docs: { indexKicker: '지식 · KNOWLEDGE BASE' } };
    const refs = scanKoValues(fixture);
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.key === 'docs.indexKicker')).toBe(true);
    expect(refs.map((r) => r.token).sort()).toEqual(['BASE', 'KNOWLEDGE']);
  });

  it('⭐한 값 안 여러 토큰 → 토큰마다 각각(중복 제거)', () => {
    const fixture = { goals: { title: 'AI AI 초안' } };
    const refs = scanKoValues(fixture);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.token).toBe('AI');
  });

  it('중첩 네임스페이스도 dot-path로 플래튼된다', () => {
    const fixture = { a: { b: { c: 'TEST 값' } } };
    const refs = scanKoValues(fixture);
    expect(refs[0]!.key).toBe('a.b.c');
  });

  // 뮤테이션 대조 — 한국어로 옮기면 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — 한국어 값(지식 · 문서고)은 GREEN', () => {
    const fixture = { docs: { indexKicker: '지식 · 문서고' } };
    expect(scanKoValues(fixture)).toEqual([]);
  });

  it('음성대조 — 1글자 대문자(A)는 GREEN(정규식 {2,} 미달)', () => {
    const fixture = { x: { y: 'A안' } };
    expect(scanKoValues(fixture)).toEqual([]);
  });

  it('음성대조 — 소문자 단어는 GREEN', () => {
    const fixture = { x: { y: 'sprint 진행 중' } };
    expect(scanKoValues(fixture)).toEqual([]);
  });
});

describe('refKey — 안정 키(값 전체 무관, 토큰 단위)', () => {
  it('값의 다른 부분이 바뀌어도 같은 토큰이면 같은 키', () => {
    const before = scanKoValues({ x: { y: '지식 · KNOWLEDGE BASE' } })[0]!;
    const after = scanKoValues({ x: { y: '문서 · KNOWLEDGE BASE 홈' } })[0]!;
    expect(refKey(before)).toBe(refKey(after));
  });
});

describe('computeNewViolations — 무관 PR no-op 표본', () => {
  it('대문자 토큰이 전혀 없는 값들은 GREEN(exit 0)', () => {
    const fixture = { x: { y: '평범한 한국어 문구', z: '숫자 42도 무방' } };
    const refs = scanKoValues(fixture);
    expect(computeNewViolations(refs, ALLOWLIST, new Set())).toEqual([]);
  });
});

// 실 파일 뮤테이션(합성 표본 아님, AC2(b) 명시) — 실 ko.json의 docs.indexKicker를
// 되돌려(문서고 → KNOWLEDGE BASE) RED가 되는지 직접 확인한다.
describe('실 파일 뮤테이션 — ko.json(docs.indexKicker 되돌리기)', () => {
  const original = loadKoJson(KO_JSON_PATH);
  const baseline = loadBaseline(BASELINE_PATH);

  it('전제: 원본은 docs.indexKicker에서 위반 0(이미 한국어)', () => {
    const refs = scanKoValues(original);
    expect(refs.some((r) => r.key === 'docs.indexKicker')).toBe(false);
  });

  it('docs.indexKicker를 원시 영단어로 되돌리면 RED', () => {
    const docsNs = original.docs as Record<string, unknown>;
    expect(docsNs.indexKicker).toBe('지식 · 문서고');
    const mutated = { ...original, docs: { ...docsNs, indexKicker: '지식 · KNOWLEDGE BASE' } };

    const refs = scanKoValues(mutated);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    expect(newViolations.some((r) => r.key === 'docs.indexKicker')).toBe(true);
  });
});

describe('scanKoValues — story #3880(실 트리 실행)', () => {
  it('실 ko.json — ALLOWLIST+baseline과 정확히 일치(신규 0·stale 0)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoValues(koJson);
    expect(refs.length).toBeGreaterThan(0);
    const baseline = loadBaseline(BASELINE_PATH);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    const staleBaseline = computeStaleBaseline(refs.filter((r) => !ALLOWLIST.has(refKey(r))), baseline);
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });
});
