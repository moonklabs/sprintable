/**
 * story #4128(유나 canon 정식 결정, 2026-09-21) — 폼 컨트롤(checkbox/radio) accent-color가
 * globals.css `@layer base { :root { accent-color: var(--primary); } }`로 전역 토큰화됐다.
 * 이 가드는 그 토큰이 가리키는 채움색이 실제로 대비 요건을 만족하는지 «정의 시점»에 잰다.
 *
 * 이전(story #4123)엔 폼 컨트롤이 네이티브 UA 기본색(토큰 시스템 밖)이라 대비를 수치로 잴
 * 방법이 없었다 — verify-nontext-icon-contrast.ts의 폼 컨트롤 축이 «존재-검사»(className에
 * 명시 accent-* override가 있을 때만 수치 검사)로 설계된 이유가 바로 그것이다. #4128로 전역
 * 기본값 자체가 토큰(--primary)이 되면서 그 전제(«네이티브 기본값 = 토큰 밖»)가 낡았다 —
 * 이 가드가 그 빈틈을 정공법으로 메운다(존재-검사 축은 명시적 override용으로 그대로 둔다).
 *
 * 재는 두 관계(유나 정본, 양 테마) —
 *   (a) 채움(accent-color가 가리키는 --primary) vs 페이지 배경(--background)·카드 배경
 *       (--card) ≥ 3:1 — 체크되지 않은 상태에서도 컨트롤 자체가 배경과 구분돼야 한다.
 *   (b) 체크 표시 vs 채움 ≥ 3:1 — 체크된 상태에서 체크 표시가 채움 위에서 보여야 한다. 체크 표시 색 =
 *       on-action(`--primary-foreground`). story 5048(T0 ①, 키트 결: 주 행동색이 라이트 검정 · 다크 흰)에서
 *       «체크는 항상 흰색(#FFFFFF, 브라우저 고정값)»이라는 옛 가정을 바로잡았다 — 실 Chromium에서 직접 재니
 *       브라우저는 채움 밝기에 맞춰 체크 색을 고른다(accent-color 흰 → 어두운 체크 · 검정 · 보라 #5b4be0 → 흰 체크 ·
 *       다크의 #8e7fff → 어두운 체크). 우리 토큰에서 그 색은 on-action과 같으므로 on-action을 읽는다.
 *       한계: iOS 앱의 WebKit(WKWebView)에서 같은지는 아직 안 쟀다 → story 5048 ④ dev 실측(폰)에서 잰다.
 * 현재 토큰 실측 기대값 — 라이트: (a) 19.09(bg) · (b) 21.00. 다크: (a) 16.67 · (b) 21.00.
 * 시험(verify-accent-color-contrast.test.ts)이 이 값을 양성대조로 고정한다 — 값이 바뀌면
 * (토큰 재정의) 이 pin이 먼저 깨져 알린다.
 *
 * oklch→sRGB 변환·대비 계산은 verify-tint-foreground-contrast.ts가 이미 검증한 유틸리티
 * (parseOklchToRgba/resolveCssVarValue/extractCssVarBlock/contrastRatio)를 그대로 재사용한다
 * — 같은 근거(실 Chromium 캡처 대조 완료, 우리 토큰 범위에서 안전)로 브라우저를 다시 띄우지
 * 않는다.
 */
import { readGlobalsCss } from './lib/read-globals-css';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCssVarBlock, resolveCssVarValue } from './verify-tint-foreground-contrast';
import { parseOklchToRgba } from '../src/lib/oklch-contrast';
import { contrastRatio } from '../src/lib/color-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');
const AA_NONTEXT_THRESHOLD = 3;

export interface AccentColorContrastResult {
  theme: 'light' | 'dark';
  fillOnBackgroundRatio: number;
  fillOnCardRatio: number;
  checkOnFillRatio: number;
}

function resolveRgb(vars: Map<string, string>, name: string): [number, number, number] {
  const raw = vars.get(name);
  if (!raw) throw new Error(`--${name} not defined in this block`);
  const resolved = resolveCssVarValue(vars, raw);
  const rgba = parseOklchToRgba(resolved);
  if (!rgba) throw new Error(`--${name} = "${raw}"(resolved: "${resolved}") is not a plain oklch()/hex value`);
  return [rgba.r, rgba.g, rgba.b];
}

export function computeAccentColorContrasts(css: string): AccentColorContrastResult[] {
  const results: AccentColorContrastResult[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const fillRgb = resolveRgb(vars, 'primary');
    const backgroundRgb = resolveRgb(vars, 'background');
    const cardRgb = resolveRgb(vars, 'card');
    const checkRgb = resolveRgb(vars, 'primary-foreground'); // 체크 표시 색 = on-action

    results.push({
      theme,
      fillOnBackgroundRatio: contrastRatio(fillRgb, backgroundRgb),
      fillOnCardRatio: contrastRatio(fillRgb, cardRgb),
      checkOnFillRatio: contrastRatio(checkRgb, fillRgb),
    });
  }
  return results;
}

function main(): number {
  const css = readGlobalsCss(GLOBALS_CSS_PATH);
  const results = computeAccentColorContrasts(css);
  let failed = false;

  console.log('[story #4128] accent-color(--primary) 채움 대비 —');
  for (const r of results) {
    console.log(
      `  ${r.theme}: 채움 vs 배경=${r.fillOnBackgroundRatio.toFixed(2)} · 채움 vs 카드=${r.fillOnCardRatio.toFixed(2)} · 체크(on-action) vs 채움=${r.checkOnFillRatio.toFixed(2)}`,
    );
    if (r.fillOnBackgroundRatio < AA_NONTEXT_THRESHOLD) {
      console.error(`FAIL: ${r.theme} 채움 vs 배경 ${r.fillOnBackgroundRatio.toFixed(2)} < ${AA_NONTEXT_THRESHOLD}:1`);
      failed = true;
    }
    if (r.fillOnCardRatio < AA_NONTEXT_THRESHOLD) {
      console.error(`FAIL: ${r.theme} 채움 vs 카드 ${r.fillOnCardRatio.toFixed(2)} < ${AA_NONTEXT_THRESHOLD}:1`);
      failed = true;
    }
    if (r.checkOnFillRatio < AA_NONTEXT_THRESHOLD) {
      console.error(`FAIL: ${r.theme} 체크(on-action) vs 채움 ${r.checkOnFillRatio.toFixed(2)} < ${AA_NONTEXT_THRESHOLD}:1`);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      '\naccent-color(--primary)가 가리키는 채움색이 폼 컨트롤 3:1 요건을 만족하지 못한다 ' +
        '(story #4128). --primary 또는 --background/--card 토큰 값을 조정한 뒤 다시 실측한다.',
    );
    return 1;
  }

  console.log('OK: 양 테마 모두 3:1 이상.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
