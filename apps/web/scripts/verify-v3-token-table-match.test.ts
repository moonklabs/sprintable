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

// story 4919(UI-R6, PO 판정 11-13): doc 3dc24888 표①의 «v3 값(정본)» 중 옛 미색 계열(bg · panel · sunk · line · ink · blue · green · amber · red …)은
// ds 팔레트로 대체됐다 — 이 값 SSOT는 이제 `design-system.css`이고 `--proof-*`는 그 참조다(표 = 4919 AC2 doc b7aacdb4 표 1).
// ds에 맞는 값이 없는 것(line-strong 공식 · citron · slate 둘 · radius)은 doc 정본 값 그대로 둔다. 이 시험은 «이름 1:1 · 빠짐 0 · 추가 0» + 위 대응을 못 박는다.
const DS = (name: string) => `var(--ds-${name})`;
const EXPECTED_PROOF_TOKENS: Record<string, string> = {
  '--proof-bg': DS('background'),
  '--proof-panel': DS('surface'),
  '--proof-sunk': DS('surface-sunk'),
  '--proof-line': DS('line'),
  '--proof-line-soft': DS('line'), // N1(a) — ds는 선이 한 단계뿐
  '--proof-line-strong': 'color-mix(in oklch, var(--proof-line) 50%, var(--proof-ink) 50%)',
  '--proof-ink': DS('ink'),
  '--proof-ink-2': DS('ink-2'),
  '--proof-ink-3': DS('ink-3'),
  '--proof-faint': DS('line-strong'), // N2(b) — 장식
  '--proof-blue': DS('info'), // N3 — 에이전트 신호 · 정보 뜻(주 행동은 별칭 --primary · --ring이 ds-action을 직접 가리킨다)
  '--proof-blue-soft': DS('info-soft'),
  '--proof-citron': '#5F8706', // N6 — 시그니처 연두, 유지
  '--proof-green': DS('done'),
  '--proof-green-soft': DS('done-soft'),
  '--proof-amber': DS('needs-hand'),
  '--proof-amber-soft': DS('needs-hand-soft'),
  '--proof-red': DS('failed'),
  '--proof-red-soft': DS('failed-soft'),
  // doc §①-1 신규 — N7 유지.
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

  it('.dark 블록 — ds로 이은 토큰은 라이트와 같은 참조(테마 전환은 ds 토큰이 한다) · citron은 다크 전용 값(4919)', () => {
    const darkBlock = extractBlock(css, /^\.dark\s*{/);
    const darkTokens = extractProofTokens(darkBlock);
    for (const [name, expected] of Object.entries(EXPECTED_PROOF_TOKENS)) {
      if (!expected.startsWith('var(--ds-')) continue;
      expect(darkTokens[name], `${name} (.dark)`).toBe(expected);
    }
    // citron은 ds에 없어 테마마다 값이 다르다 — 라이트 값과 달라야 한다.
    expect(darkTokens['--proof-citron']).not.toBe(EXPECTED_PROOF_TOKENS['--proof-citron']);
  });
});
