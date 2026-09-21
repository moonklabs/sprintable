import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnlayeredClassRules, ALLOWLIST } from './verify-no-unlayered-css-class';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

describe('findUnlayeredClassRules (story #4125 — Cascade Layers 회귀가드)', () => {
  it('does NOT flag a class rule inside @layer components', () => {
    const css = `@layer components {\n.foo {\n  position: relative;\n}\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([]);
  });

  it('⭐flags a bare class rule at the top level (양성대조 — story #4125 실사고 재현)', () => {
    const css = `.x {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 1, selector: '.x' }]);
  });

  it('flags a bare ::before pseudo-element rule at the top level', () => {
    const css = `.x::before {\n  content: '';\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 1, selector: '.x::before' }]);
  });

  it('does NOT flag a compound/descendant selector (out of scope — ㉠ declared limitation)', () => {
    const css = `.a .b {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([]);
  });

  it('does NOT flag an attribute selector', () => {
    const css = `[data-x] {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([]);
  });

  it('does NOT flag a class rule inside @media', () => {
    const css = `@media (max-width: 640px) {\n.x {\n  position: relative;\n}\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([]);
  });

  it('does NOT flag a class rule inside @keyframes-adjacent content (keyframes selectors are not class rules)', () => {
    const css = `@keyframes foo {\n0% { opacity: 0; }\n100% { opacity: 1; }\n}\n.animate-foo {\n  animation: foo 1s;\n}\n`;
    // .animate-foo here is still top-level/unlayered — this asserts the keyframes block itself
    // doesn't get misparsed as a "class rule" (0% and 100% are not `.class` selectors).
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 5, selector: '.animate-foo' }]);
  });

  it('reports the correct line number past the first line, with comments preserving line count', () => {
    const css = `/* comment\nspanning\nlines */\n.x {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 4, selector: '.x' }]);
  });

  it('does not flag content inside a nested @layer (e.g. @layer base { .x { ... } })', () => {
    const css = `@layer base {\n.x {\n  position: relative;\n}\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([]);
  });
});

describe('ALLOWLIST — story #4125 정본(2건, 각 이유 실측 확認)', () => {
  it('contains exactly .dark and .dashboard-shell-root (수 자체가 회귀가드 — 조용히 늘면 걸림)', () => {
    expect([...ALLOWLIST].sort()).toEqual(['.dark', '.dashboard-shell-root']);
  });
});

describe('실 globals.css 스캔 — story #4125 AC1(이관 완료) 확認', () => {
  it('⭐실 globals.css의 최상위 단일-클래스 규칙이 ALLOWLIST와 정확히 일치한다(11건 이관 완료 pin)', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const found = findUnlayeredClassRules(css);
    const selectors = found.map((r) => r.selector).sort();
    expect(selectors).toEqual([...ALLOWLIST].sort());
  });

  it('.proof-surface(및 ::before/-lift/-press)·animate-* 7개는 더 이상 최상위에 없다(#4121 sticky 재발 방지 pin)', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const found = findUnlayeredClassRules(css);
    const selectors = new Set(found.map((r) => r.selector));
    for (const s of ['.proof-surface', '.proof-surface::before', '.proof-surface-lift', '.proof-surface-press',
      '.animate-slide-in', '.animate-entrance-spin', '.animate-onboarding-enter', '.animate-ai-loading-indeterminate',
      '.animate-proof-pulse', '.animate-proof-sweep', '.animate-proof-check-in']) {
      expect(selectors.has(s), `${s}가 여전히 최상위(레이어 밖)에 있음`).toBe(false);
    }
  });
});
