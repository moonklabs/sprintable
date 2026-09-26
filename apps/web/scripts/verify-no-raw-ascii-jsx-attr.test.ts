import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, computeNewViolations, computeStaleBaseline, loadBaseline, refKey, scanContent, scanRepo } from './verify-no-raw-ascii-jsx-attr';
import { measureFsReads } from './test-utils/fs-work';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'raw-ascii-jsx-attr-baseline.json');

describe('scanContent — story #3880 AC2(a) 셀프테스트', () => {
  it('⭐watched 프롭(title)의 순 ASCII 리터럴 → RED', () => {
    const src = `function C() { return <LayerLabel title="Brief" />; }`;
    expect(scanContent(src, 'fake.tsx')).toHaveLength(1);
  });

  it('⭐watched 프롭(aria-label)의 순 ASCII 리터럴 → RED', () => {
    const src = `function C() { return <button aria-label="Close" />; }`;
    const refs = scanContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.prop).toBe('aria-label');
    expect(refs[0]!.text).toBe('Close');
  });

  // 뮤테이션 대조 — t()로 감싸면(JsxExpression, StringLiteral 아님) 이 스캔이 반드시
  // 0을 낸다는 것 자체를 자가 증명. workcell.tsx의 실 사고 자리 재현.
  it('뮤테이션 대조 — title={t(\'briefTitle\')}로 감싼 형은 GREEN(StringLiteral 아니라 JsxExpression)', () => {
    const src = `function C() { return <LayerLabel title={t('briefTitle')} />; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // story #3880 CHANGES①(PO PR 코멘트, 2026-09-14 16:13Z) — JsxExpression으로 감싼
  // 리터럴(`title={'Brief'}`)도 잡는지 직접 확인. 최초 버전은 StringLiteral만 봐서
  // 이 형을 놓쳤다.
  it('⭐CHANGES① — JsxExpression으로 감싼 문자열 리터럴(title={\'Brief\'}) → RED', () => {
    const src = `function C() { return <LayerLabel title={'Brief'} />; }`;
    const refs = scanContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text).toBe('Brief');
  });

  it('⭐CHANGES① — JsxExpression으로 감싼 템플릿 리터럴(title={`Brief`}) → RED', () => {
    const src = 'function C() { return <LayerLabel title={`Brief`} />; }';
    const refs = scanContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text).toBe('Brief');
  });

  // 음성대조 — JsxExpression 안이 CallExpression(t('key'))이면 여전히 GREEN(문자열
  // 리터럴이 아니라 함수 호출 — extractLiteralText가 undefined 반환).
  it('음성대조 — JsxExpression 안이 CallExpression(t(\'key\'))이면 GREEN', () => {
    const src = `function C() { return <LayerLabel title={t('briefTitle')} />; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // 양성대조 — 구두점(…·—) 섞인 값도 공유 술어(isUntranslatedCopy)로 잡힌다(3876
  // 가드와 동형 — page-embed-node.tsx의 실 사고 재현).
  it('⭐양성대조 — 구두점 섞인 값("Enter document slug or ID…")도 공유 술어로 RED', () => {
    const src = `function C() { return <input placeholder="Enter document slug or ID…" />; }`;
    const refs = scanContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text).toBe('Enter document slug or ID…');
  });

  // 음성대조 — watched 목록 밖 프롭(className 등)은 안 걸린다.
  it('음성대조 — 목록 밖 프롭(className="Foo")은 GREEN', () => {
    const src = `function C() { return <div className="Foo" />; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 한국어 값은 첫 글자가 알파벳이 아니라 구조적으로 배제.
  it('음성대조 — 한국어 값(title="브리프")은 GREEN', () => {
    const src = `function C() { return <LayerLabel title="브리프" />; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanContent('export function {{{ broken', 'broken.tsx')).toThrow(/파싱 실패/);
  });
});

describe('refKey — 안정 키(줄 번호 무관)', () => {
  it('줄 밀림 양성대조 — 위에 무관한 줄을 끼워도 refKey는 안 바뀐다(line만 바뀜)', () => {
    const before = `function C() { return <LayerLabel title="Brief" />; }`;
    const after = `// 무관한 한 줄\nfunction C() { return <LayerLabel title="Brief" />; }`;
    const refsBefore = scanContent(before, 'fake.tsx');
    const refsAfter = scanContent(after, 'fake.tsx');
    expect(refsBefore[0]!.line).not.toBe(refsAfter[0]!.line);
    expect(refKey(refsBefore[0]!)).toBe(refKey(refsAfter[0]!));
  });
});

describe('computeNewViolations — 무관 PR no-op 표본', () => {
  it('watched 프롭을 전혀 안 쓰는 평범한 컴포넌트는 GREEN(exit 0)', () => {
    const src = `function C({ title, count }: { title: string; count: number }) {
      return <div><h1>{title}</h1><span>{count}</span></div>;
    }`;
    const refs = scanContent(src, 'unrelated.tsx');
    expect(computeNewViolations(refs, ALLOWLIST, new Set())).toEqual([]);
  });
});

// 실 파일 뮤테이션(합성 표본 아님, AC2(a) 명시) — workcell.tsx의 briefTitle을
// 되돌려(t('briefTitle') → 원시 "Brief") RED가 되는지 직접 확인한다.
describe('실 파일 뮤테이션 — workcell.tsx(title 되돌리기)', () => {
  const REL_FILE = 'components/workcell/workcell.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const original = readFileSync(ABS_FILE, 'utf8');
  const baseline = loadBaseline(BASELINE_PATH);

  it('전제: 원본은 이 파일에서 위반 0(title이 전부 t()로 감싸짐)', () => {
    const refs = scanContent(original, REL_FILE);
    expect(refs).toEqual([]);
  });

  it('LayerLabel title을 원시 리터럴로 되돌리면 RED', () => {
    const target = "<LayerLabel title={t('briefTitle')} question={t('briefQuestion')} className=\"mb-2.5\" />";
    expect(original.includes(target)).toBe(true);
    const mutated = original.replace(target, '<LayerLabel title="Brief" question={t(\'briefQuestion\')} className="mb-2.5" />');
    expect(mutated).not.toBe(original);

    const refs = scanContent(mutated, REL_FILE);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    expect(newViolations.some((r) => r.text === 'Brief')).toBe(true);
  });
});

// story #3880 CHANGES①(PO PR 코멘트, 2026-09-14 16:13Z) — 실 파일 실측 양성대조:
// page-embed-node.tsx의 placeholder="Enter document slug or ID…"가 baseline에
// 있어야만 GREEN이라는 것(baseline에서 빼면 RED)을 직접 확인 — CHANGES① 전에는
// JsxExpression 감쌈이 아니라 직접 속성값이라 원래도 잡혔어야 하나, 구두점(…) 때문에
// 옛 ASCII_WORD_RE는 놓쳤을 자리(3876 가드와 동형 사고).
describe('실 파일 실측 양성대조 — page-embed-node.tsx(placeholder, 구두점 섞인 자리)', () => {
  const REL_FILE = 'components/docs/extensions/page-embed-node.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const original = readFileSync(ABS_FILE, 'utf8');
  const baseline = loadBaseline(BASELINE_PATH);

  it('원본 실측 — placeholder="Enter document slug or ID…"가 이 가드에 걸린다', () => {
    const refs = scanContent(original, REL_FILE);
    expect(refs.some((r) => r.text === 'Enter document slug or ID…')).toBe(true);
  });

  it('baseline에서 빼면(un-baseline) RED — 술어가 실제로 판정에 반영된다', () => {
    const refs = scanContent(original, REL_FILE);
    const baselineWithoutThis = new Set([...baseline].filter((k) => k !== `${REL_FILE}::placeholder::Enter document slug or ID…`));
    const newViolations = computeNewViolations(refs, ALLOWLIST, baselineWithoutThis);
    expect(newViolations.some((r) => r.text === 'Enter document slug or ID…')).toBe(true);
  });
});

describe('scanRepo — story #3880(실 트리 실행)', () => {
  // story #4333 — 시한은 기본(행 가드 · 벽시계 예산 폐기). 일의 양은 결정적으로 — 한 스캔에서 같은 파일을 두 번 읽으면 RED(measureFsReads).
  it('실 트리(apps/web/src) — ALLOWLIST+baseline과 정확히 일치(신규 0·stale 0)', () => {
    const { result: __scan, maxPerFile, files: __filesRead } = measureFsReads(() => scanRepo(SRC_ROOT));
    const refs = __scan;
    expect(maxPerFile.count, `${maxPerFile.file} — 한 스캔에서 두 번 이상 읽음(일이 늘었다)`).toBeLessThanOrEqual(1);
    expect(__filesRead, '읽기를 실제로 셌다(헛돌지 않게)').toBeGreaterThan(0);
    const baseline = loadBaseline(BASELINE_PATH);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    const staleBaseline = computeStaleBaseline(refs.filter((r) => !ALLOWLIST.has(refKey(r))), baseline);
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });
});
