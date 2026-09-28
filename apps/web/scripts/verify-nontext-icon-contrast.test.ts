import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanContent, computeViolations, findExplicitBgVar, violationKey, type IconContrastCandidate } from './verify-nontext-icon-contrast';
import { extractCssVarBlock } from './verify-tint-foreground-contrast';

const STATUS_COLORS = ['destructive', 'info', 'success', 'warning', 'brand', 'primary'];

// 픽스처를 함수 본문으로 감싸 유효한 TSX로 만든다 — 자매 가드(verify-cross-element-tint-text)와
// 동일 관례.
const scan = (jsx: string) => scanContent(`function C(){return (${jsx})}`, 'fixture.tsx', STATUS_COLORS);

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');
const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
const { vars } = extractCssVarBlock(css, ':root');

describe('verify-nontext-icon-contrast — story #4123 AC3 (유나 정본 artifact f08541fd 접지 5건)', () => {
  // ── ① 단독 아이콘 버튼(접지: chat-input.tsx:890, type="button" 트리거+아이콘만) — 3:1 대상 ──
  it('⭐flags a standalone icon inside a type="button" element with no other visible content (접지 ①)', () => {
    const cands = scan(`<button type="button" aria-label="첨부"><Paperclip className="h-4 w-4" /></button>`);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ category: 'standalone-icon-button', tag: 'Paperclip' });
  });

  it('does NOT flag when the interactive element has a visible text sibling (곁 텍스트 = 중복 제외)', () => {
    expect(scan(`<button type="button"><CheckCircle className="size-3.5" />승인</button>`)).toHaveLength(0);
  });

  it('does NOT flag a plain <div> (인터랙티브 아님 — role="button" 없이는 대상 밖)', () => {
    expect(scan(`<div className="text-info"><Info className="size-4" /></div>`)).toHaveLength(0);
  });

  it('flags an element with role="button" the same way as a native button', () => {
    const cands = scan(`<span role="button" aria-label="닫기"><X className="size-3" /></span>`);
    expect(cands).toHaveLength(1);
  });

  // ── ③ 상태 단독 그래픽(접지: 지금 레포 0건 — 로직만 픽스처로 pin) ──
  it('flags a rounded-full status-color dot with no sibling text (상태 단독 그래픽, 합성 픽스처)', () => {
    const cands = scan(`<div><span className="rounded-full bg-success size-2" /></div>`);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ category: 'standalone-status-graphic', textColorVar: 'success' });
  });

  it('does NOT flag a status dot when a sibling conveys the same meaning (접지 team-presence-panel — 인접 텍스트=중복 제외)', () => {
    const cands = scan(`<div><span className="rounded-full bg-success size-2" aria-hidden /><h3>작업 중</h3></div>`);
    expect(cands).toHaveLength(0);
  });

  it('does NOT flag a neutral (non-status-color) rounded-full node (순수 장식, 접지 doc-status-rail.tsx:308)', () => {
    expect(scan(`<div><span className="rounded-full border-2 border-background bg-border size-2" aria-hidden /></div>`)).toHaveLength(0);
  });

  // ── aria-hidden은 판별 축이 아니다(유나 정본 핵심 경고) — 단독 아이콘 버튼은 aria-hidden이어도 대상 ──
  it('⭐aria-hidden on the glyph does NOT exclude a standalone icon button (판별 축 아님 — 거짓음성 방지 핀)', () => {
    const cands = scan(`<button type="button" aria-label="첨부"><Paperclip className="h-4 w-4" aria-hidden /></button>`);
    expect(cands).toHaveLength(1);
  });
});

describe('classStringsFromExpr — 템플릿 리터럴 안 삼항 재귀(접지 chat-input.tsx:890 실사고)', () => {
  it('⭐detects a color class living inside a ternary interpolated into a template literal', () => {
    const jsx = '<button type="button" aria-label="a" className={`p-1 ${cond ? "bg-info/10 text-info" : "text-muted-foreground"}`}><Paperclip className="h-4 w-4" /></button>';
    const cands = scan(jsx);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.textColorVar).toBe('info');
    expect(cands[0]!.bgVar).toEqual({ varName: 'info', alphaPct: 10 });
  });
});

describe('findExplicitBgVar — -tint/-bg 접미 vs 순수 vs 알파 유틸 (접지 story-detail-panel.tsx:1816 실사고)', () => {
  it('⭐resolves bg-<X>-tint to the SEPARATE "-tint" variable, not the base family (self-contrast 버그 재현 방지)', () => {
    expect(findExplicitBgVar('bg-destructive-tint text-destructive', STATUS_COLORS)).toEqual({ varName: 'destructive-tint', alphaPct: null });
  });
  it('resolves bg-<X>-bg to the "-bg" variable', () => {
    expect(findExplicitBgVar('bg-warning-bg', STATUS_COLORS)).toEqual({ varName: 'warning-bg', alphaPct: null });
  });
  it('resolves bare bg-<X> to the family variable itself (opaque)', () => {
    expect(findExplicitBgVar('bg-info', STATUS_COLORS)).toEqual({ varName: 'info', alphaPct: null });
  });
  it('resolves bg-<X>/N to the family variable with an alpha percentage (composite 필요)', () => {
    expect(findExplicitBgVar('bg-info/10', STATUS_COLORS)).toEqual({ varName: 'info', alphaPct: 10 });
  });
  it('returns null when no status-color bg class is present', () => {
    expect(findExplicitBgVar('flex-shrink-0 rounded-md', STATUS_COLORS)).toBeNull();
  });
});

describe('computeViolations — 실 globals.css 대비 계산(양성·음성 픽스처)', () => {
  const base = { file: 'fixture.tsx', line: 1, category: 'standalone-icon-button' as const, tag: 'Icon' };

  it('⭐flags a self-contrast pair (text-destructive vs its own solid --destructive) — 못 틀리는 대조(mutation-kill 표적)', () => {
    const cand: IconContrastCandidate = { ...base, textColorVar: 'destructive', bgVar: { varName: 'destructive', alphaPct: null } };
    const violations = computeViolations([cand], vars);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.ratio).toBeCloseTo(1, 1);
  });

  it('does NOT flag text-info against the resolved 10%-alpha bg-info/10 composite (접지 chat-input.tsx:890 실측 — 라이트 ≈5.25)', () => {
    const cand: IconContrastCandidate = { ...base, textColorVar: 'info', bgVar: { varName: 'info', alphaPct: 10 } };
    expect(computeViolations([cand], vars)).toHaveLength(0);
  });

  it('does NOT flag against the default page background when no explicit bg is set', () => {
    const cand: IconContrastCandidate = { ...base, textColorVar: 'destructive', bgVar: 'background' };
    // text-destructive on plain page bg — 정의 시점 AA(4.5:1)를 이미 통과하는 토큰이므로
    // 더 낮은 문턱(3:1)도 자연히 통과한다(verify-tint-foreground-contrast.ts AC3 전제 재사용).
    expect(computeViolations([cand], vars)).toHaveLength(0);
  });

  it('skips candidates with no resolvable text color (currentColor 상속만·상태색 클래스 없음 — 대상 밖)', () => {
    const cand: IconContrastCandidate = { ...base, textColorVar: null, bgVar: 'background' };
    expect(computeViolations([cand], vars)).toHaveLength(0);
  });
});

describe('violationKey — 안정 키(파일+카테고리)', () => {
  it('produces a stable key independent of the measured ratio', () => {
    expect(violationKey({ file: 'a.tsx', category: 'standalone-icon-button' })).toBe('a.tsx::standalone-icon-button');
  });
});
