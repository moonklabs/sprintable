import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, computeNewViolations, computeStaleBaseline, loadBaseline, refKey, scanContent, scanRepo } from './verify-no-raw-ascii-jsx-text';
import { measureFsReads } from './test-utils/fs-work';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'raw-ascii-jsx-text-baseline.json');

describe('scanContent — story #3876 셀프테스트', () => {
  it('⭐순 ASCII 단어 하나({}없이 그대로) → RED', () => {
    const src = `function C() { return <p>Dispatch</p>; }`;
    expect(scanContent(src, 'fake.tsx')).toHaveLength(1);
  });

  it('⭐순 ASCII 구(공백 포함, "Blocked by") → RED', () => {
    const src = `function C() { return <span>Blocked by</span>; }`;
    const refs = scanContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text).toBe('Blocked by');
  });

  // 뮤테이션 대조 — t()로 감싸면(JsxExpression 안 CallExpression) JsxText 자체가 없어져
  // 이 스캔이 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — {t(\'dispatch\')}로 감싼 형은 GREEN(JsxText 아니라 JsxExpression)', () => {
    const src = `function C() { return <p>{t('dispatch')}</p>; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 한국어 텍스트는 첫 글자가 알파벳이 아니라 정규식이 구조적으로 배제.
  it('음성대조 — 한국어 텍스트는 GREEN(ASCII_WORD_RE 불일치)', () => {
    const src = `function C() { return <p>이벤트 전달</p>; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 구두점/구분자 단독(「—」·「·」·「/」 등)은 알파벳으로 시작 안 해 배제.
  it('음성대조 — 구분자 단독 텍스트("—"·"·")는 GREEN', () => {
    const src = `function C() { return <span>—</span>; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 순수 숫자(카운트 등)는 알파벳으로 시작 안 해 배제.
  it('음성대조 — 순수 숫자 텍스트("42")는 GREEN', () => {
    const src = `function C() { return <span>42</span>; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 1글자는 최소 길이(2) 미달로 배제(과오탐 축소, PO 미승인 확장 없이).
  it('음성대조 — 1글자 텍스트("A")는 GREEN(최소 길이 미달)', () => {
    const src = `function C() { return <span>A</span>; }`;
    expect(scanContent(src, 'fake.tsx')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanContent('export function {{{ broken', 'broken.tsx')).toThrow(/파싱 실패/);
  });
});

describe('refKey — 안정 키(줄 번호 무관)', () => {
  // 양성대조 — 무관한 PR이 같은 파일 윗줄에 한 줄 끼워도(줄 밀림), 텍스트 내용 자체가
  // 안 바뀌는 한 refKey(file::text)는 그대로다 — story #3875 CHANGES와 같은 계약.
  it('줄 밀림 양성대조 — 위에 무관한 줄을 끼워도 refKey는 안 바뀐다(line만 바뀜)', () => {
    const before = `function C() { return <p>Dispatch</p>; }`;
    const after = `// 무관한 한 줄\nfunction C() { return <p>Dispatch</p>; }`;
    const refsBefore = scanContent(before, 'fake.tsx');
    const refsAfter = scanContent(after, 'fake.tsx');
    expect(refsBefore[0]!.line).not.toBe(refsAfter[0]!.line);
    expect(refKey(refsBefore[0]!)).toBe(refKey(refsAfter[0]!));
  });
});

// 무관 PR no-op 표본 — 이 축과 무관한 평범한 컴포넌트는 위반 0으로 조용히 통과한다는
// 것 자체를 표본 1로 고정(다른 PR의 CI를 이 축이 헛돌려 막지 않는다는 확인).
describe('computeNewViolations — 무관 PR no-op 표본', () => {
  it('ASCII 순 텍스트를 전혀 안 쓰는 평범한 컴포넌트는 GREEN(exit 0)', () => {
    const src = `function C({ title, count }: { title: string; count: number }) {
      return <div><h1>{title}</h1><span>{count}</span></div>;
    }`;
    const refs = scanContent(src, 'unrelated.tsx');
    expect(computeNewViolations(refs, ALLOWLIST, new Set())).toEqual([]);
  });
});

// 실 파일 뮤테이션(합성 표본 아님) — story-detail-panel.tsx의 Labels 헤딩을 되돌려
// (t('labelsSectionTitle') → 원시 "Labels") RED가 되는지 직접 확인한다.
describe('실 파일 뮤테이션 — story-detail-panel.tsx(Labels 헤딩)', () => {
  const REL_FILE = 'components/kanban/story-detail-panel.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const original = readFileSync(ABS_FILE, 'utf8');
  const baseline = loadBaseline(BASELINE_PATH);

  it('전제: 원본은 이 파일에서 "Labels" 원시 위반 0(t(\'labelsSectionTitle\')로 감싸짐)', () => {
    const refs = scanContent(original, REL_FILE);
    expect(refs.filter((r) => r.text === 'Labels')).toEqual([]);
  });

  it('Labels 헤딩을 원시 텍스트로 되돌리면 RED', () => {
    const target = "<span>{t('labelsSectionTitle')}</span>";
    expect(original.includes(target)).toBe(true);
    const mutated = original.replace(target, '<span>Labels</span>');
    expect(mutated).not.toBe(original);

    const refs = scanContent(mutated, REL_FILE);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    expect(newViolations.some((r) => r.text === 'Labels')).toBe(true);
  });
});

// story #3880 CHANGES ④(PO PR 코멘트, 2026-09-14 16:13Z) — 실 파일 뮤테이션 대신 실 파일
// «실측»(이미 baseline에 있는 실 사고 자리) 양성대조: isUntranslatedCopy 공유 술어로
// 교체한 게 실제로 이 자리를 잡는지(baseline에서 빼면 RED) 직접 확인한다. "Loading
// document…"는 아직 낱말 미확定이라 baseline에 남아있다 — 고쳐진 게 아니라 "이 술어가
// 이 자리를 볼 수 있다"는 것만 증명.
describe('실 파일 실측 양성대조 — page-embed-node.tsx("Loading document…", 구두점 섞인 자리)', () => {
  const REL_FILE = 'components/docs/extensions/page-embed-node.tsx';
  const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
  const original = readFileSync(ABS_FILE, 'utf8');
  const baseline = loadBaseline(BASELINE_PATH);

  it('원본 실측 — "Loading document…"가 이 가드에 걸린다(옛 ASCII_WORD_RE는 …때문에 놓쳤을 자리)', () => {
    const refs = scanContent(original, REL_FILE);
    expect(refs.some((r) => r.text === 'Loading document…')).toBe(true);
  });

  it('baseline에서 빼면(un-baseline) RED — 술어가 실제로 판정에 반영된다', () => {
    const refs = scanContent(original, REL_FILE);
    const baselineWithoutThis = new Set([...baseline].filter((k) => k !== `${REL_FILE}::Loading document…`));
    const newViolations = computeNewViolations(refs, ALLOWLIST, baselineWithoutThis);
    expect(newViolations.some((r) => r.text === 'Loading document…')).toBe(true);
  });
});

describe('scanRepo — story #3876(실 트리 실행)', () => {
  // story #4333 — 시한은 기본(행 가드 · 벽시계 예산 폐기). 일의 양은 결정적으로 — 한 스캔에서 같은 파일을 두 번 읽으면 RED(measureFsReads).
  it('실 트리(apps/web/src) — ALLOWLIST+baseline과 정확히 일치(신규 0·stale 0)', () => {
    const { result: __scan, maxPerFile, files: __filesRead } = measureFsReads(() => scanRepo(SRC_ROOT));
    const refs = __scan;
    expect(maxPerFile.count, `${maxPerFile.file} — 한 스캔에서 두 번 이상 읽음(일이 늘었다)`).toBeLessThanOrEqual(1);
    expect(__filesRead, '읽기를 실제로 셌다(헛돌지 않게)').toBeGreaterThan(0);
    expect(refs.length).toBeGreaterThan(0);
    const baseline = loadBaseline(BASELINE_PATH);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    const staleBaseline = computeStaleBaseline(refs.filter((r) => !ALLOWLIST.has(refKey(r))), baseline);
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });
});
