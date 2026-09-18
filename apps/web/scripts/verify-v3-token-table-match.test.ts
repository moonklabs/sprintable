/**
 * story #3826(UX-v3·FE 2, 페드루 PO 確定 2026-09-13) AC2 — globals.css의 라이트
 * `:root` `--proof-*`(19개) + `--proof-radius-soft` + 신규 `--proof-slate(-soft)` 값이
 * 유나 「[UX-v3] 토큰 표」 doc(3dc24888) 표①의 「v3 값(정본)」과 1:1인지 전수 대조.
 * 빠짐 0(doc의 19개 전부 검사)·추가 0(globals.css에 doc이 모르는 --proof-* 신규 토큰이
 * 있으면 실패 — slate 2개만 명시적 예외). `.dark`는 doc §④에 따라 이 스토리에서 무변경
 * (라이트 값과 달라야 정상 — 별도 스냅샷으로 "그대로인지"만 확認, 값 자체는 안 잼).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GLOBALS_CSS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/app/globals.css',
);

function extractBlock(css: string, selectorRe: RegExp): string {
  const lines = css.split('\n');
  const start = lines.findIndex((l) => selectorRe.test(l));
  if (start === -1) throw new Error(`selector ${selectorRe} not found`);
  const end = lines.findIndex((l, i) => i > start && /^\s*}\s*$/.test(l));
  if (end === -1) throw new Error(`closing brace for ${selectorRe} not found`);
  return lines.slice(start + 1, end).join('\n');
}

function extractProofTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--proof-([a-zA-Z0-9-]+):\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out[`--proof-${m[1]}`] = m[2].trim();
  }
  return out;
}

// doc 3dc24888 표① "v3 값(정본)" 그대로(대문자 hex, doc 표기와 동일 케이스) — "현행
// 유지"로 명시된 토큰(line-strong 공식·faint·citron·red·red-soft)은 교체 전 원래 값
// 그대로(doc의 명시적 "추정값 0" 원칙 — 새로 지어내지 않는다).
const EXPECTED_PROOF_TOKENS: Record<string, string> = {
  '--proof-bg': '#F7F6F3',
  '--proof-panel': '#FFFFFF',
  '--proof-sunk': '#F1EFEA',
  '--proof-line': '#E7E4DE',
  '--proof-line-soft': '#EEEBE5',
  '--proof-line-strong': 'color-mix(in oklch, var(--proof-line) 50%, var(--proof-ink) 50%)',
  '--proof-ink': '#1D1C1A',
  '--proof-ink-2': '#5F5C57',
  '--proof-ink-3': '#6E6C67',
  '--proof-faint': '#9C9E93',
  '--proof-blue': '#3B5BA5',
  '--proof-blue-soft': '#E7EDF7',
  '--proof-citron': '#5F8706',
  '--proof-green': '#3B7856',
  '--proof-green-soft': '#E9F1EC',
  '--proof-amber': '#946719',
  '--proof-amber-soft': '#FBF3E2',
  '--proof-red': '#C33B3B',
  '--proof-red-soft': '#FBEAEA',
  // doc §①-1 신규.
  '--proof-slate': '#636F7D',
  '--proof-slate-soft': '#EEF1F4',
  // doc §② radius.
  '--proof-radius-soft': '12px',
};

describe('story #3826 AC2 — v3 토큰 표 1:1 대조', () => {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf8');
  const rootBlock = extractBlock(css, /^:root\s*{/);
  const actual = extractProofTokens(rootBlock);

  it('빠짐 0 — doc 표①의 22개 토큰(19 기존 + slate 2 + radius-soft) 전부 globals.css :root에 존재', () => {
    const missing = Object.keys(EXPECTED_PROOF_TOKENS).filter((k) => !(k in actual));
    expect(missing, `globals.css :root에서 빠진 토큰: ${missing.join(', ')}`).toEqual([]);
  });

  it('전수 대조 — 이름·값 1:1(불일치 0)', () => {
    const mismatches: string[] = [];
    for (const [name, expected] of Object.entries(EXPECTED_PROOF_TOKENS)) {
      const got = actual[name];
      if (got !== expected) {
        mismatches.push(`${name}: expected "${expected}", got "${got ?? '(missing)'}"`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('추가 0 — globals.css :root에 doc이 모르는 --proof-* 신규 토큰이 없다', () => {
    const extra = Object.keys(actual).filter((k) => !(k in EXPECTED_PROOF_TOKENS));
    expect(extra, `doc에 없는 신규 --proof-* 토큰: ${extra.join(', ')}`).toEqual([]);
  });

  it('.dark 블록은 이 스토리에서 무변경 — 라이트 값과 달라야 정상(doc §④, 다크는 미정)', () => {
    const darkBlock = extractBlock(css, /^\.dark\s*{/);
    const darkTokens = extractProofTokens(darkBlock);
    // 다크가 라이트 v3 값으로 실수로 덮였다면 이 스토리에서 절대 안 되는 회귀 —
    // 최소 bg/ink 둘만이라도 라이트 v3 값과 달라야 함을 pin(전수 대조는 스코프 밖,
    // "다크 v3=미정"이라 비교할 정본 자체가 없다 — doc §④).
    expect(darkTokens['--proof-bg']).not.toBe(EXPECTED_PROOF_TOKENS['--proof-bg']);
    expect(darkTokens['--proof-ink']).not.toBe(EXPECTED_PROOF_TOKENS['--proof-ink']);
  });
});
