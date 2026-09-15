import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  computeNewViolations,
  computeNewWholeValueViolations,
  computeStaleBaseline,
  computeStaleTokenAllowlist,
  computeStaleWholeValueBaseline,
  loadBaseline,
  loadKoJson,
  refKey,
  scanKoValues,
  scanKoWholeValues,
  TOKEN_ALLOWLIST,
  WHOLE_VALUE_ALLOWLIST,
  wholeValueRefKey,
} from './verify-no-ascii-token-in-ko-value';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ascii-token-in-ko-value-baseline.json');
const WHOLE_VALUE_BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'ascii-whole-value-in-ko-value-baseline.json',
);

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
  it('실 ko.json — 키ALLOWLIST+TOKEN_ALLOWLIST+baseline과 정확히 일치(신규 0·stale 0)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoValues(koJson);
    expect(refs.length).toBeGreaterThan(0);
    const baseline = loadBaseline(BASELINE_PATH);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline, TOKEN_ALLOWLIST);
    const refsNotInKeyAllowlist = refs.filter((r) => !ALLOWLIST.has(refKey(r)) && !TOKEN_ALLOWLIST.has(r.token));
    const staleBaseline = computeStaleBaseline(refsNotInKeyAllowlist, baseline);
    const staleTokenAllowlist = computeStaleTokenAllowlist(refs, TOKEN_ALLOWLIST);
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
    expect(staleTokenAllowlist).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// story #3880 CHANGES③(PO PR 코멘트, 2026-09-14 16:13Z) — 토큰 단위 ALLOWLIST.
// ---------------------------------------------------------------------------

describe('computeNewViolations — TOKEN_ALLOWLIST(토큰 단위, 어느 키든)', () => {
  it('⭐TOKEN_ALLOWLIST에 있는 토큰은 «어느 키에 나와도» 허용(키ALLOWLIST와 다름 — 자리 무관)', () => {
    const fixture = { some: { newKey: 'API 호출 실패' } };
    const refs = scanKoValues(fixture);
    expect(refs).toHaveLength(1);
    // 이 키는 키ALLOWLIST·baseline 어디에도 없지만 토큰(API) 자체가 TOKEN_ALLOWLIST라 GREEN.
    const newViolations = computeNewViolations(refs, ALLOWLIST, new Set(), TOKEN_ALLOWLIST);
    expect(newViolations).toEqual([]);
  });

  it('음성대조 — TOKEN_ALLOWLIST 밖 토큰(예: 합성 "FOOBAR")은 여전히 위반', () => {
    const fixture = { some: { newKey: 'FOOBAR 상태' } };
    const refs = scanKoValues(fixture);
    const newViolations = computeNewViolations(refs, ALLOWLIST, new Set(), TOKEN_ALLOWLIST);
    expect(newViolations).toHaveLength(1);
  });

  it('하위호환 — tokenAllowlist 인자 생략하면 기존 2/3-인자 호출부와 동일하게 동작', () => {
    const fixture = { some: { newKey: 'API 호출 실패' } };
    const refs = scanKoValues(fixture);
    // tokenAllowlist 생략 — API도 걸린다(기본값 빈 Set).
    const newViolations = computeNewViolations(refs, ALLOWLIST, new Set());
    expect(newViolations).toHaveLength(1);
  });
});

describe('computeStaleTokenAllowlist — TOKEN_ALLOWLIST 죽은 항목 탐지', () => {
  it('⭐ko.json 어디에도 없는 토큰은 stale로 잡힌다', () => {
    const refs = scanKoValues({ x: { y: 'API 호출' } });
    const stale = computeStaleTokenAllowlist(refs, new Set(['API', 'ZZZNOTREAL']));
    expect(stale).toEqual(['ZZZNOTREAL']);
  });

  it('음성대조 — 전부 실제로 쓰이는 토큰이면 stale 0', () => {
    const refs = scanKoValues({ x: { y: 'API 호출' } });
    expect(computeStaleTokenAllowlist(refs, new Set(['API']))).toEqual([]);
  });
});

// 실 파일 실측 양성대조 — story #3922(§⑤ 낱말 드리프트 전량 정리, 2026-09-15)가 #3880
// 잔존 드리프트(PO·QA·PM·AU·SP·WIP)를 판정대로 전량 정리했는지 직접 확인. PO/QA/PM/AU는
// 역할 약어 패밀리(AU는 "자동화" 병기)로 TOKEN_ALLOWLIST 이관, SP/WIP는 "포인트"/"진행
// 한도"로 한국어 전환돼 값 자체가 사라졌다(baseline도 TOKEN_ALLOWLIST도 어디에도 안 남음).
describe('실측 — story #3922가 PO·QA·PM·AU·SP·WIP를 判定대로 정리했다', () => {
  it('PO·QA·PM·AU는 TOKEN_ALLOWLIST 안(역할 약어 패밀리)', () => {
    for (const t of ['PO', 'QA', 'PM', 'AU']) {
      expect(TOKEN_ALLOWLIST.has(t)).toBe(true);
    }
  });

  it('SP·WIP는 한국어로 전환돼 ko.json 어디에도 남아있지 않다(baseline도 TOKEN_ALLOWLIST도 불필요)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoValues(koJson);
    for (const t of ['SP', 'WIP']) {
      expect(TOKEN_ALLOWLIST.has(t)).toBe(false);
      expect(refs.some((r) => r.token === t)).toBe(false);
    }
  });

  it('baseline은 이제 0(빈 목록) — story #3922가 34건 전량 처리', () => {
    const baseline = loadBaseline(BASELINE_PATH);
    expect(baseline.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 축 2 — story #3880 CHANGES②(PO PR 코멘트, 2026-09-14 16:13Z) — 값 전체 순 ASCII 단어.
// ---------------------------------------------------------------------------

describe('scanKoWholeValues — story #3880 CHANGES② 셀프테스트', () => {
  it('⭐값 전체가 순 ASCII 단어(Title-Case, CAPS 아님) → RED', () => {
    const fixture = { workcell: { pipelineQueued: 'Queued' } };
    const refs = scanKoWholeValues(fixture);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.key).toBe('workcell.pipelineQueued');
  });

  it('⭐값 전체가 순 ASCII 구(공백 포함, "Needs input") → RED', () => {
    const fixture = { workcell: { pipelineNeedsInput: 'Needs input' } };
    expect(scanKoWholeValues(fixture)).toHaveLength(1);
  });

  // 음성대조 — 축1(CAPS_TOKEN_RE)은 대문자 토큰이 없으면 못 잡지만, 축2는 값 전체가
  // 순 ASCII면 CAPS 여부와 무관하게 잡는다는 것을 직접 대조.
  it('음성대조 — 축1(CAPS)은 "Queued"를 못 잡는다(대문자 토큰 없음)', () => {
    const fixture = { workcell: { pipelineQueued: 'Queued' } };
    expect(scanKoValues(fixture)).toEqual([]);
  });

  // 뮤테이션 대조 — 한국어로 옮기면 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — 한국어 값(대기 중)은 GREEN', () => {
    const fixture = { workcell: { pipelineQueued: '대기 중' } };
    expect(scanKoWholeValues(fixture)).toEqual([]);
  });

  // 음성대조 — 값의 일부만 ASCII 단어고 나머지가 한국어면(부분 매치) 축2는 GREEN —
  // "값 전체"가 조건이라 축1(부분 토큰 매치)과 역할이 겹치지 않는다.
  it('음성대조 — 값 일부만 ASCII 단어(한국어 섞임)면 GREEN(값 전체 조건)', () => {
    const fixture = { x: { y: '지식 · KNOWLEDGE BASE' } };
    expect(scanKoWholeValues(fixture)).toEqual([]);
  });
});

describe('wholeValueRefKey — 안정 키(값 전체 축은 키 단위)', () => {
  it('같은 키면 값이 바뀌어도 같은 refKey(값 자체가 바뀌면 다른 위반이지만 키로 식별)', () => {
    const a = scanKoWholeValues({ workcell: { pipelineQueued: 'Queued' } })[0]!;
    const b = scanKoWholeValues({ workcell: { pipelineQueued: 'Pending' } })[0]!;
    expect(wholeValueRefKey(a)).toBe(wholeValueRefKey(b));
  });
});

// 실 파일 실측 양성대조(합성 표본 아님, PO 명시: "양성대조=pipelineQueued 되돌림 RED") —
// 이 PR에서 고친 workcell.pipelineQueued("대기 중")를 원시 영문("Queued")으로 되돌리면
// 축2가 실제로 잡는지 직접 확인한다. 축1(CAPS)만으로는 이 자리가 GREEN이었다는 것이
// PO가 지적한 실 사고 — 축2가 그 갭을 봉쇄한다는 증명.
describe('실 파일 실측 양성대조 — ko.json(workcell.pipelineQueued 되돌리기, 축1 갭 봉쇄 증명)', () => {
  const original = loadKoJson(KO_JSON_PATH);
  const wholeValueBaseline = loadBaseline(WHOLE_VALUE_BASELINE_PATH);

  it('전제: 원본은 workcell.pipelineQueued에서 축1·축2 둘 다 위반 0(이미 한국어)', () => {
    const workcellNs = original.workcell as Record<string, unknown>;
    expect(workcellNs.pipelineQueued).toBe('대기 중');
    expect(scanKoValues(original).some((r) => r.key === 'workcell.pipelineQueued')).toBe(false);
    expect(scanKoWholeValues(original).some((r) => r.key === 'workcell.pipelineQueued')).toBe(false);
  });

  it('되돌리면(Queued) 축1(CAPS)은 여전히 GREEN — 이게 PO가 지적한 갭', () => {
    const workcellNs = original.workcell as Record<string, unknown>;
    const mutated = { ...original, workcell: { ...workcellNs, pipelineQueued: 'Queued' } };
    const refs = scanKoValues(mutated);
    expect(refs.some((r) => r.key === 'workcell.pipelineQueued')).toBe(false);
  });

  it('되돌리면(Queued) 축2(전체값)는 RED — 갭이 봉쇄됐다', () => {
    const workcellNs = original.workcell as Record<string, unknown>;
    const mutated = { ...original, workcell: { ...workcellNs, pipelineQueued: 'Queued' } };
    const refs = scanKoWholeValues(mutated);
    const newViolations = computeNewWholeValueViolations(refs, WHOLE_VALUE_ALLOWLIST, wholeValueBaseline);
    expect(newViolations.some((r) => r.key === 'workcell.pipelineQueued')).toBe(true);
  });
});

describe('scanKoWholeValues — story #3880 CHANGES②(실 트리 실행)', () => {
  it('실 ko.json — WHOLE_VALUE_ALLOWLIST+baseline과 정확히 일치(신규 0·stale 0)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoWholeValues(koJson);
    expect(refs.length).toBeGreaterThan(0);
    const baseline = loadBaseline(WHOLE_VALUE_BASELINE_PATH);
    const newViolations = computeNewWholeValueViolations(refs, WHOLE_VALUE_ALLOWLIST, baseline);
    const staleBaseline = computeStaleWholeValueBaseline(
      refs.filter((r) => !WHOLE_VALUE_ALLOWLIST.has(wholeValueRefKey(r))),
      baseline,
    );
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });
});
