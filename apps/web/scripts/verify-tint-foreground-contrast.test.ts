import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCssVarBlock, discoverTintFamilies, discoverBgFamilies, computeFamilyContrasts, computeCrossFamilyBgReference } from './verify-tint-foreground-contrast';

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

// story #2575 AC1 — discoverTintFamilies와 대칭. 다단어 배경 토큰(tiptap-code-bg 등)이
// [\w]+ 경계(하이픈 미포함)로 자동 제외되는지가 이 테스트의 핵심(우연이 아니라 설계).
describe('discoverBgFamilies — story #2575 AC1(단일-단어 -bg만, tint와 동일 경계)', () => {
  it('finds every single-word "-bg" suffixed var', () => {
    const vars = new Map([
      ['destructive-bg', 'x'], ['warning-bg', 'x'], ['foo-bg', 'x'],
      ['destructive', 'x'], ['background', 'x'],
    ]);
    expect(discoverBgFamilies(vars)).toEqual(['destructive', 'foo', 'warning']);
  });

  it('다단어 배경 토큰(하이픈 포함)은 제외된다 — tiptap-code-bg·highlight-search-bg류', () => {
    const vars = new Map([
      ['warning-bg', 'x'], ['tiptap-code-bg', 'x'], ['highlight-search-bg', 'x'],
    ]);
    expect(discoverBgFamilies(vars)).toEqual(['warning']);
  });

  it('returns empty when there are none (no crash)', () => {
    expect(discoverBgFamilies(new Map([['background', 'x']]))).toEqual([]);
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
    const lightResult = results.find((r) => r.theme === 'light' && r.family === 'destructive' && r.kind === 'tint')!;
    expect(lightResult.foregroundOnBackgroundRatio).toBeLessThan(4.5);
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
      expect(r.foregroundOnBackgroundRatio).toBeGreaterThanOrEqual(4.5);
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
    expect(results.every((r) => r.kind === 'tint')).toBe(true);
  });

  // story #2575 AC1 — tint와 대칭: 새 `-bg` 계열도 코드 수정 없이 자동으로 잡힌다.
  it('새 -bg 계열을 CSS에 추가만 해도 코드 수정 없이 검사 대상이 된다', () => {
    const cssWithNewBgFamily = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --info: oklch(0.55 0.18 250);
  --info-bg: oklch(0.97 0.02 250);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --info: oklch(0.65 0.18 250);
  --info-bg: oklch(0.22 0.04 250);
}
`;
    const results = computeFamilyContrasts(cssWithNewBgFamily);
    expect(results.map((r) => r.family)).toEqual(['info', 'info']);
    expect(results.every((r) => r.kind === 'bg')).toBe(true);
  });
});

// story #2575 AC4 — 교차-계열 참고표(computeCrossFamilyBgReference)의 양성대조: #2960 실제
// 위반 형태(text-destructive on bg-warning-bg)를 합성 CSS로 재현해 이 함수가 그 값을 낸다는
// 것을 pin한다. 이 값은 게이트에 안 쓰인다(AC3 — 인간관문 근거자료일 뿐).
describe('computeCrossFamilyBgReference — story #2575 AC4 양성대조(교차-계열 참고표)', () => {
  it('#2960 형태(destructive 글자 on warning -bg)를 합성 CSS로 재현하면 참고값이 나온다', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-tint: oklch(0.577 0.245 27.325 / 10%);
  --warning: oklch(0.75 0.16 85);
  --warning-bg: oklch(0.97 0.03 85);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-tint: oklch(0.704 0.191 22.216 / 10%);
  --warning: oklch(0.70 0.16 85);
  --warning-bg: oklch(0.22 0.04 85);
}
`;
    const results = computeCrossFamilyBgReference(css);
    const hit = results.find((r) => r.theme === 'light' && r.textFamily === 'destructive' && r.bgFamily === 'warning');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeGreaterThan(0);
  });

  it('실 globals.css로 계산하면 light/destructive-on-warning-bg가 #2960 실측값(4.37)과 근사 일치한다', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const results = computeCrossFamilyBgReference(css);
    const hit = results.find((r) => r.theme === 'light' && r.textFamily === 'destructive' && r.bgFamily === 'warning')!;
    expect(hit.ratio).toBeCloseTo(4.37, 1);
  });

  it('같은-계열 쌍(textFamily === bgFamily)도 참고표에 포함된다 — warning-on-warning-bg가 #2960 2.06과 근사 일치', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const results = computeCrossFamilyBgReference(css);
    const hit = results.find((r) => r.theme === 'light' && r.textFamily === 'warning' && r.bgFamily === 'warning')!;
    expect(hit.ratio).toBeCloseTo(2.06, 1);
  });
});

describe('real repo globals.css — 실제 정의가 전 조합 AA(4.5)를 통과한다(story #2420 AC1/AC5 · #2575 AC1)', () => {
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
      expect(r.foregroundOnBackgroundRatio, `${r.theme}/${r.family}/${r.kind}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('regression proof — using the family color itself (the old pattern) would have failed at least one combination (this is why the rule exists)', () => {
    const anyFamilyColorFails = results.some((r) => !Number.isNaN(r.familyColorOnBackgroundRatio) && r.familyColorOnBackgroundRatio < 4.5);
    expect(anyFamilyColorFails).toBe(true);
  });

  // story #2575 AC1 — -bg가 이 스토리 이전엔 아예 안 잡혔다는 것 자체가 #2960의 근본원인.
  it('finds the -bg kind too, for the same four status families(success·warning·info·destructive — primary는 -bg 없음)', () => {
    const bgResults = results.filter((r) => r.kind === 'bg');
    const bgFamilies = new Set(bgResults.map((r) => r.family));
    for (const f of ['destructive', 'warning', 'info', 'success']) {
      expect(bgFamilies.has(f)).toBe(true);
    }
    expect(bgFamilies.has('primary')).toBe(false);
    expect(bgResults.length).toBe(8); // 4 families × 2 themes
  });

  // story #2575 AC4 — 오늘 #2960 수치가 이 정의 검사 자체(같은-계열 참고값)에서도 재현된다.
  it('AC4 양성대조 — light/warning의 familyColorOnBackgroundRatio(-bg)가 #2960 2.06과 근사 일치한다', () => {
    const r = results.find((x) => x.theme === 'light' && x.family === 'warning' && x.kind === 'bg')!;
    expect(r.familyColorOnBackgroundRatio).toBeCloseTo(2.06, 1);
  });
});
