import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCssVarBlock, discoverTintFamilies, discoverBgFamilies, discoverBorderFamilies, computeFamilyContrasts, computeCrossFamilyBgReference, computeCrossCheckContrasts, computeNonTextCrossCheckContrasts, deriveCrossCheckTextVars } from './verify-tint-foreground-contrast';

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

// story #4094 AC2 — tint/bg와 대칭. sidebar-border(비-status UI 리전 경계색, NON_STATUS_
// FAMILY_NAMES 등재)가 실 globals.css 실측에서 걸려 하드코딩 제외 목록에 새로 추가된 계기.
describe('discoverBorderFamilies — story #4094 AC2(단일-단어 -border만, tint/bg와 동일 경계)', () => {
  it('finds every single-word "-border" suffixed var', () => {
    const vars = new Map([
      ['destructive-border', 'x'], ['warning-border', 'x'], ['foo-border', 'x'],
      ['destructive', 'x'], ['border', 'x'],
    ]);
    expect(discoverBorderFamilies(vars)).toEqual(['destructive', 'foo', 'warning']);
  });

  it('sidebar처럼 status family가 아닌 -border 토큰은 NON_STATUS_FAMILY_NAMES로 제외된다', () => {
    const vars = new Map([
      ['destructive-border', 'x'], ['sidebar-border', 'x'],
    ]);
    expect(discoverBorderFamilies(vars)).toEqual(['destructive']);
  });

  it('returns empty when there are none (no crash)', () => {
    expect(discoverBorderFamilies(new Map([['border', 'x']]))).toEqual([]);
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

  // story #2917(Proofline 토큰 매핑표) — globals.css의 destructive/warning 값이 proof-red/
  // proof-amber로 바뀌어 이 참고값(과거 #2960 사고 재현치)이 새 팔레트 수치로 이동했다. 이
  // 테스트의 역할은 "그 사고가 지금도 재현되는가"가 아니라 "계산이 실 globals.css 정의로부터
  // 결정적으로 같은 값을 낸다"는 회귀가드이므로, 새 팔레트에서 실측한 값으로 갱신한다(#2960
  // 원 사고 자체는 위 첫 테스트가 합성 CSS로 이미 영구 고정해 재현 가능하다).
  // story #3826(2026-09-13, doc 3dc24888) — v3 AA 조정(amber #946719)으로 값이 다시
  // 이동: 4.67 → 4.74(실측).
  it('실 globals.css로 계산하면 light/destructive-on-warning-bg가 proof 팔레트 실측값(4.74)과 근사 일치한다', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const results = computeCrossFamilyBgReference(css);
    const hit = results.find((r) => r.theme === 'light' && r.textFamily === 'destructive' && r.bgFamily === 'warning')!;
    expect(hit.ratio).toBeCloseTo(4.74, 1);
  });

  // story #3826(2026-09-13, doc 3dc24888) — v3 AA 조정(amber #946719, warning-bg 위
  // 4.51:1로 조정)으로 값이 이동: 3.25 → 4.51(실측). doc §⑥가 이 정확한 숫자를 "AA
  // 통과 조정 근거"로 명시(amber 대비표).
  it('같은-계열 쌍(textFamily === bgFamily)도 참고표에 포함된다 — warning-on-warning-bg가 proof 팔레트 실측값(4.51)과 근사 일치', () => {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const results = computeCrossFamilyBgReference(css);
    const hit = results.find((r) => r.theme === 'light' && r.textFamily === 'warning' && r.bgFamily === 'warning')!;
    expect(hit.ratio).toBeCloseTo(4.51, 1);
  });
});

// story #4055 — computeCrossCheckContrasts(non-status 강조색 × 전 tint/bg 계열)의 못 틀리는
// 대조. #4048 흐름 밴드 자기감사가 실물로 걸린 조합(text-brand on bg-info-tint, 라이트
// 10px bold, 4.0<4.5)을 합성 CSS로 재현해 RED를, 안전하게 고친 조합(text-foreground)은
// 별도 함수(computeFamilyContrasts)가 이미 GREEN으로 pin한다(위 real-repo 스위트).
describe('computeCrossCheckContrasts — story #4055 못 틀리는 대조(AC3)', () => {
  it('#4048 원 사고 재현 — text-brand on bg-info-tint(라이트)를 합성 CSS로 넣으면 RED(<4.5)', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --brand: oklch(0.56 0.17 254);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.55 0.18 250 / 10%);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --brand: oklch(0.64 0.17 254);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.65 0.18 250 / 12%);
}
`;
    const results = computeCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.textVar === 'brand' && r.family === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeLessThan(4.5);
  });

  it('음성대조 — 채도 낮고 어두운 강조색은 같은 tint 위에서 통과한다(계산 자체가 항상 FAIL을 내지 않는다는 증거)', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --brand: oklch(0.25 0.05 254);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.55 0.18 250 / 10%);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --brand: oklch(0.25 0.05 254);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.65 0.18 250 / 12%);
}
`;
    const results = computeCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.textVar === 'brand' && r.family === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeGreaterThanOrEqual(4.5);
  });

  // story #4094 AC1 — 예전엔 CROSS_CHECK_TEXT_VARS가 고정 ['brand']라 "-tint/-bg 계열이
  // CSS에 있어도 brand가 없으면 빈 배열"이 맞았다. 지금은 deriveCrossCheckTextVars가 상태색
  // 자신(예: info)도 -tint/-bg만 있으면 자동 편입하므로, 그 전제 자체가 이 스토리로 바뀌었다
  // — "정말 아무 계열도 없을 때만 빈 배열"로 픽스처를 좁혀 크래시-안전성 취지를 보존한다.
  it('-tint/-bg 계열이 하나도 없는 CSS에서도 죽지 않고 그냥 빈 배열을 낸다(크래시-안전)', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
}
`;
    expect(computeCrossCheckContrasts(css)).toEqual([]);
  });

  // story #4094 AC1 — brand가 없어도 상태색(info)이 자기 -tint를 갖고 있으면 이제 자동으로
  // 이 교차게이트 대상이 된다(deriveCrossCheckTextVars가 discoverTintFamilies/discoverBgFamilies
  // 산출물을 그대로 흡수 — 손으로 'info'를 추가 등록할 필요 0, 하드코딩 0이라는 AC1의 핵심).
  it('brand 없이 상태색(info)만 있어도 자기 자신의 -tint와 교차게이트된다(#4094 신규 동작)', () => {
    const css = `
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
    const results = computeCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.textVar === 'info' && r.family === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
  });
});

// story #4094 AC1 — 상태색-대-상태색 교차(예: text-destructive on info-tint)의 못 틀리는 대조.
// deriveCrossCheckTextVars 확장 전에는 이 조합 자체가 검사 대상이 아니어서 어떤 값이든
// 게이트를 안 탔다 — 지금은 진짜로 막는다는 것을 RED/GREEN 한 쌍으로 증명한다.
describe('computeCrossCheckContrasts — story #4094 AC1 못 틀리는 대조(상태색 자신의 교차)', () => {
  it('상태색끼리 교차가 미달이면(text-destructive on info-tint) RED(<4.5)', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.60 0.20 25);
  --destructive-tint: oklch(0.60 0.20 25 / 10%);
  --info: oklch(0.60 0.20 25 / 1%);
  --info-tint: oklch(0.60 0.20 25 / 8%);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.60 0.20 25);
  --destructive-tint: oklch(0.60 0.20 25 / 10%);
  --info: oklch(0.60 0.20 25 / 1%);
  --info-tint: oklch(0.60 0.20 25 / 8%);
}
`;
    const results = computeCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.textVar === 'destructive' && r.family === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeLessThan(4.5);
  });

  it('음성대조 — 충분히 대비되는 상태색 조합은 통과한다', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.35 0.20 25);
  --destructive-tint: oklch(0.35 0.20 25 / 10%);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.97 0.02 250);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.90 0.05 25);
  --destructive-tint: oklch(0.90 0.05 25 / 10%);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.22 0.04 250);
}
`;
    const results = computeCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.textVar === 'destructive' && r.family === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeGreaterThanOrEqual(4.5);
  });
});

// story #4094 AC2 — computeNonTextCrossCheckContrasts(border-<family>-border·ring-<family>
// × -tint/-bg, 3:1)의 못 틀리는 대조.
describe('computeNonTextCrossCheckContrasts — story #4094 AC2 못 틀리는 대조(비텍스트 3:1)', () => {
  it("border 미달('border' usage, 거의 안 보이는 명도차)이면 RED(<3)", () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.60 0.20 25);
  --destructive-border: oklch(0.97 0.01 25);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.97 0.02 250);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.70 0.19 22);
  --destructive-border: oklch(0.97 0.01 25);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.22 0.04 250);
}
`;
    const results = computeNonTextCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.usage === 'border' && r.family === 'destructive' && r.bgFamily === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeLessThan(3);
  });

  it('음성대조 — 충분히 대비되는 border 조합은 3:1을 통과한다', () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.60 0.20 25);
  --destructive-border: oklch(0.35 0.20 25);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.97 0.02 250);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.70 0.19 22);
  --destructive-border: oklch(0.90 0.05 25);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.22 0.04 250);
}
`;
    const results = computeNonTextCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.usage === 'border' && r.family === 'destructive' && r.bgFamily === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeGreaterThanOrEqual(3);
  });

  it("ring 축('ring' usage, 전용 토큰 없이 base family 색을 그대로 쓴다)도 같은 방식으로 게이트된다", () => {
    const css = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --destructive: oklch(0.97 0.01 25);
  --destructive-tint: oklch(0.97 0.01 25 / 10%);
  --info: oklch(0.55 0.18 250);
  --info-tint: oklch(0.97 0.02 250);
}
.dark {
  --background: oklch(0.18 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --destructive: oklch(0.70 0.19 22);
  --destructive-tint: oklch(0.70 0.19 22 / 10%);
  --info: oklch(0.65 0.18 250);
  --info-tint: oklch(0.22 0.04 250);
}
`;
    const results = computeNonTextCrossCheckContrasts(css);
    const hit = results.find((r) => r.theme === 'light' && r.usage === 'ring' && r.family === 'destructive' && r.bgFamily === 'info' && r.kind === 'tint');
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeLessThan(3);
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

  // story #3826(2026-09-13, doc 3dc24888) 실측 발견 — v3 AA 조정(amber #946719 등, doc
  // §⑥)이 이 규칙의 원래 반례(light/destructive family-color-ratio, 예전 4.5 미만)까지
  // 우연히 4.5 문턱 위로 밀어 올렸다(실측 4.504 — 전 조합 중 최솟값). "family color를
  // 텍스트로 써도 지금은 전부 AA를 통과한다"는 게 "그 패턴을 써도 된다"는 뜻은 아니다
  // (-foreground를 쓰는 규칙 자체는 무관하게 유효 — 다음 팔레트 조정이 이 마진을 다시
  // 깎을 수 있다는 방어). 이 테스트는 그 마진 자체를 pin — 4.5 밑으로 내려가거나(회귀 —
  // 그때 원래 "반례 존재" 단언을 복원할 것) 마진이 눈에 띄게 넓어지면(팔레트가 크게
  // 바뀌었다는 신호) 리뷰가 필요하다는 뜻으로 이 테스트가 깨진다.
  it('마진 관찰(story #3826) — family color를 텍스트로 썼을 때의 최소 대비가 AA 문턱(4.5)에 바짝 붙어 있다(v3 조정의 부수효과, 규칙 자체는 여전히 유효)', () => {
    const familyColorRatios = results
      .map((r) => r.familyColorOnBackgroundRatio)
      .filter((v) => !Number.isNaN(v));
    const min = Math.min(...familyColorRatios);
    expect(min).toBeGreaterThanOrEqual(4.5);
    expect(min).toBeLessThan(4.6); // 문턱에서 크게 안 멀어졌는지 — 멀어지면 팔레트가 또 바뀐 것.
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

  // story #2575 AC4 — #2960 수치가 이 정의 검사 자체(같은-계열 참고값)에서도 재현된다.
  // story #2917: proof-amber 팔레트로 값이 이동(3.25) — 위 computeCrossFamilyBgReference
  // 테스트 주석과 동일 이유. story #3826(2026-09-13, doc 3dc24888): v3 AA 조정으로
  // 다시 이동(3.25 → 4.51, amber #946719).
  it('AC4 양성대조 — light/warning의 familyColorOnBackgroundRatio(-bg)가 proof 팔레트 실측값(4.51)과 근사 일치한다', () => {
    const r = results.find((x) => x.theme === 'light' && x.family === 'warning' && x.kind === 'bg')!;
    expect(r.familyColorOnBackgroundRatio).toBeCloseTo(4.51, 1);
  });

  // story #4055 AC2(전수벤치) — 실 globals.css의 non-status 강조색(brand) 교차 미달이
  // GRANDFATHER_BASELINE(스크립트 내부, 발견 시점 10건) 밖으로 안 새는지 pin한다. 이 표가
  // 늘면(새 미달) 이 테스트가 깨져 리뷰를 강제하고, 줄면(누가 고쳤으면) 실패하지 않되
  // main()의 stale-grandfather 안내로 정리를 유도한다(강한 등호가 아니라 상한만 거는 이유
  // — grandfather 소멸은 축하할 일이지 막을 일이 아니다).
  it('brand 교차 미달 — 실 globals.css가 지금 딱 10건이고(발견 당시 그대로), 더 늘지 않았다', () => {
    const crossCheck = computeCrossCheckContrasts(css);
    const failing = crossCheck.filter((r) => r.ratio < 4.5 && r.textVar === 'brand');
    expect(failing.length).toBeLessThanOrEqual(10);
  });

  // story #4094 AC1/AC3(전수벤치) — deriveCrossCheckTextVars가 상태색 자신을 처음 편입하며
  // 이 스토리가 실측으로 발견한 신규 미달(전부 4.24~4.46, brand와 별개 원인) — 같은 계약
  // (상한만·«늘지 않음»), PR 본문 수치 = 11건(발견 당시 그대로).
  it('상태색-자신 교차 미달 — 실 globals.css가 지금 딱 11건이고(#4094 발견 당시 그대로), 더 늘지 않았다', () => {
    const crossCheck = computeCrossCheckContrasts(css);
    const failing = crossCheck.filter((r) => r.ratio < 4.5 && r.textVar !== 'brand');
    expect(failing.length).toBeLessThanOrEqual(11);
  });

  // story #4094 AC2 — 비텍스트(border·ring) 3:1 게이트는 실 globals.css에서 신규 미달 0건
  // (텍스트 4.5:1보다 문턱이 낮아 이미 여유 있던 조합들이 전부 통과). NONTEXT_GRANDFATHER_
  // BASELINE이 빈 채로도 안전함을 pin — 향후 새 미달이 생기면 이 테스트가 먼저 깨진다.
  it('비텍스트(border·ring) 교차 미달 — 실 globals.css는 지금 0건이다(#4094 AC2)', () => {
    const nonTextCrossCheck = computeNonTextCrossCheckContrasts(css);
    const failing = nonTextCrossCheck.filter((r) => r.ratio < 3);
    expect(failing.length).toBe(0);
  });

  // story #4094 AC1 — deriveCrossCheckTextVars가 discoverTintFamilies/discoverBgFamilies
  // 산출물(실 globals.css는 destructive·info·primary·success·warning 5종)을 그대로 흡수하는지
  // 실물로 pin — "5종"이라는 AC1 숫자가 하드코딩이 아니라 유도 결과임을 보인다.
  it('deriveCrossCheckTextVars가 실 globals.css에서 상태색 5종(destructive·info·primary·success·warning) + brand를 유도한다', () => {
    const { vars } = extractCssVarBlock(css, ':root');
    expect(deriveCrossCheckTextVars(vars)).toEqual(['brand', 'destructive', 'info', 'primary', 'success', 'warning']);
  });
});
