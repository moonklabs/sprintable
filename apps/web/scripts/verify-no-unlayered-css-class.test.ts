import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnlayeredClassRules, ALLOWLIST } from './verify-no-unlayered-css-class';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

describe('findUnlayeredClassRules (story #4125/#4127 — Cascade Layers 회귀가드, 범위: 클래스/속성 선택자를 품은 depth-0 선택자 전부)', () => {
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

  it('⭐flags a compound/descendant selector at the top level (story #4127 — 범위 확장, 이전엔 스코프 밖이었음)', () => {
    const css = `.a .b {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 1, selector: '.a .b' }]);
  });

  it('⭐flags an attribute selector at the top level (story #4127 — 범위 확장)', () => {
    const css = `[data-x] {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 1, selector: '[data-x]' }]);
  });

  it('flags a compound attribute+class descendant selector at the top level', () => {
    const css = `[data-type="foo"] .bar {\n  position: relative;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 1, selector: '[data-type="foo"] .bar' }]);
  });

  it('does NOT flag a pure pseudo-class selector with no class/attribute component (e.g. :root)', () => {
    const css = `:root {\n  --foo: 1;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([]);
  });

  it('normalizes a comma-separated selector that spans multiple physical lines into a single-space-joined string (story #4127 실측 — .tiptap-content ul,\\n.tiptap-content ol 꼴)', () => {
    const css = `.a,\n.b {\n  color: red;\n}\n`;
    expect(findUnlayeredClassRules(css)).toEqual([{ line: 2, selector: '.a, .b' }]);
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

describe('ALLOWLIST — story #4125/#4127 정본(46종 고유 selector — 47건 중 `.ProseMirror .scrollbar-visible pre`가 별개 규칙 2개로 같은 문자열이라 Set에선 1종, 각 이유 실측 확認)', () => {
  it('has exactly 46 entries (수 자체가 회귀가드 — 조용히 늘면 걸림)', () => {
    expect(ALLOWLIST.size).toBe(46);
  });

  it('contains the theme-switch entry carried over from #4125', () => {
    expect(ALLOWLIST.has('.dark')).toBe(true);
  });

  it('does NOT contain the migrated dashboard-shell-root rule (story #4006 AC8 PO CHANGES-1 ③ — .v3-shell-root와 나란히 @layer components로 이관 완료)', () => {
    expect(ALLOWLIST.has('.dashboard-shell-root')).toBe(false);
  });

  it('contains the 7 story #2229 ProseMirror scrollbar entries (이관 절대 금지)', () => {
    for (const s of [
      '.ProseMirror .scrollbar-visible',
      '.ProseMirror .scrollbar-visible pre',
      '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar',
      '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-track',
      '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-thumb',
      '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-thumb:hover',
    ]) {
      expect(ALLOWLIST.has(s), `${s} 누락`).toBe(true);
    }
  });

  it('contains the 2 sonner internal-DOM entries', () => {
    expect(ALLOWLIST.has('[data-sonner-toast]')).toBe(true);
    expect(ALLOWLIST.has('[data-sonner-toast] [data-icon]')).toBe(true);
  });

  it('does NOT contain the migrated sidebar rule (story #4127 — @layer components로 이관 완료)', () => {
    expect(ALLOWLIST.has('[data-sidebar="menu-button"][data-popup-open]')).toBe(false);
  });
});

describe('실 globals.css 스캔 — story #4127 AC1(47건 판정 완료) 확認', () => {
  it('found 47건(원문 규칙 수) 중 고유 selector 문자열이 ALLOWLIST(46종)와 정확히 일치한다', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const found = findUnlayeredClassRules(css);
    expect(found.length, '원문 규칙 수(중복 selector 포함) — 47건 고정(story #4006 AC8이 .dashboard-shell-root를 @layer로 이관해 48→47)').toBe(47);
    const selectors = [...new Set(found.map((r) => r.selector))].sort();
    expect(selectors).toEqual([...ALLOWLIST].sort());
  });

  it('.proof-surface(및 ::before/-lift/-press)·animate-* 7개는 여전히 최상위에 없다(#4121 sticky 재발 방지 pin, #4125 이관 유지 확認)', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const found = findUnlayeredClassRules(css);
    const selectors = new Set(found.map((r) => r.selector));
    for (const s of ['.proof-surface', '.proof-surface::before', '.proof-surface-lift', '.proof-surface-press',
      '.animate-slide-in', '.animate-entrance-spin', '.animate-onboarding-enter', '.animate-ai-loading-indeterminate',
      '.animate-proof-pulse', '.animate-proof-sweep', '.animate-proof-check-in']) {
      expect(selectors.has(s), `${s}가 여전히 최상위(레이어 밖)에 있음`).toBe(false);
    }
  });

  it('⭐[data-sidebar="menu-button"][data-popup-open]는 더 이상 최상위에 없다(story #4127 이관 pin)', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const found = findUnlayeredClassRules(css);
    const selectors = new Set(found.map((r) => r.selector));
    expect(selectors.has('[data-sidebar="menu-button"][data-popup-open]')).toBe(false);
  });

  it('⭐story #4131의 --shell-chrome-h 선언(.dashboard-shell-root[data-topbar-hidden])은 @layer components 안이라 최상위에 없다(ALLOWLIST 확장 대신 이관 — 페드루 PO 2026-09-22)', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const found = findUnlayeredClassRules(css);
    const selectors = new Set(found.map((r) => r.selector));
    expect(selectors.has('.dashboard-shell-root[data-topbar-hidden]')).toBe(false);
    expect(ALLOWLIST.has('.dashboard-shell-root[data-topbar-hidden]')).toBe(false);
  });
});
