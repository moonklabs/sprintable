import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCssVarBlock, discoverTintFamilies, computeFamilyContrasts } from './verify-tint-foreground-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

describe('extractCssVarBlock', () => {
  const css = `
:root {
  --a: 1;
  --b: oklch(0.5 0.1 20);
}
.dark {
  --a: 2;
}
`;
  it('extracts only the named selector\'s declarations', () => {
    const { vars } = extractCssVarBlock(css, ':root');
    expect(vars.get('a')).toBe('1');
    expect(vars.get('b')).toBe('oklch(0.5 0.1 20)');
    expect(vars.has('nonexistent')).toBe(false);
  });

  it('does not leak the other block\'s value for the same var name', () => {
    const { vars } = extractCssVarBlock(css, '.dark');
    expect(vars.get('a')).toBe('2');
  });
});

describe('discoverTintFamilies — story #2420 핵심(사용처를 안 세도 새 계열이 자동으로 잡힌다)', () => {
  it('finds every "-tint" suffixed var, not a hardcoded list', () => {
    const vars = new Map([
      ['destructive-tint', 'x'], ['warning-tint', 'x'], ['foo-tint', 'x'],
      ['destructive', 'x'], ['background', 'x'],
    ]);
    expect(discoverTintFamilies(vars)).toEqual(['destructive', 'foo', 'warning']);
  });

  it('returns empty when there are none (no crash)', () => {
    expect(discoverTintFamilies(new Map([['background', 'x']]))).toEqual([]);
  });
});

// story #2420 AC6 — 양성대조: 이 검사가 «실패할 수 있어야» 한다. 실 globals.css는 지금
// 전부 통과하므로(위 real-repo 테스트), 통과만 보이면 "이 검사가 애초에 아무것도 안 재는
// 것 아니냐"는 의심을 못 지운다 — 합성 CSS로 일부러 미달 값을 정의해 빨간불이 뜨는 것을
// 직접 보인다(#2410/#2414의 같은 규율 — 판정을 pin하는 테스트).
describe('computeFamilyContrasts — 양성대조(AC6): 미달 정의는 빨간불이어야 한다', () => {
  it('foreground가 배경과 거의 같은 명도면 FAIL로 잡힌다', () => {
    const badCss = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.98 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-tint: oklch(0.577 0.245 27.325 / 10%);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-tint: oklch(0.704 0.191 22.216 / 10%);
}
`;
    const results = computeFamilyContrasts(badCss);
    const lightResult = results.find((r) => r.theme === 'light' && r.family === 'destructive')!;
    expect(lightResult.foregroundOnTintRatio).toBeLessThan(4.5);
  });

  it('음성대조 — 실제 정상 정의(진짜 foreground)는 같은 조건에서 통과한다', () => {
    const goodCss = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-tint: oklch(0.577 0.245 27.325 / 10%);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-tint: oklch(0.704 0.191 22.216 / 10%);
}
`;
    const results = computeFamilyContrasts(goodCss);
    for (const r of results) {
      expect(r.foregroundOnTintRatio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('새 계열(예: "info")을 CSS에 추가만 해도 코드 수정 없이 검사 대상이 된다', () => {
    const cssWithNewFamily = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.55 0.18 250 / 10%);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.65 0.18 250 / 12%);
}
`;
    const results = computeFamilyContrasts(cssWithNewFamily);
    expect(results.map((r) => r.family)).toEqual(['info', 'info']);
  });
});

describe('real repo globals.css — 실제 정의가 전 조합 AA(4.5)를 통과한다(story #2420 AC1/AC5)', () => {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const results = computeFamilyContrasts(css);

  it('finds at least the four families the spec names(destructive·warning·info·success)', () => {
    const families = new Set(results.map((r) => r.family));
    for (const f of ['destructive', 'warning', 'info', 'success']) {
      expect(families.has(f)).toBe(true);
    }
  });

  it('every family × theme combination passes 4.5 with text-foreground', () => {
    for (const r of results) {
      expect(r.foregroundOnTintRatio, `${r.theme}/${r.family}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('regression proof — using the family color itself (the old pattern) would have failed at least one combination (this is why the rule exists)', () => {
    const anyFamilyColorFails = results.some((r) => !Number.isNaN(r.familyColorOnTintRatio) && r.familyColorOnTintRatio < 4.5);
    expect(anyFamilyColorFails).toBe(true);
  });
});
