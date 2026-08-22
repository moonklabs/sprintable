/**
 * story #2480(유나 규격) 회귀가드 — `--muted-foreground`는 `--muted`·`--background`·`--card`
 * 위에서 전부 쓰인다(테이블 헤더·플레이스홀더·칩·보조텍스트 도처). 라이트 테마 실측(2026-08-06)
 * 에서 `--muted-foreground` on `--muted` = 4.39:1로 AA(4.5) 미달이 발견됐다(#2866 가디언 리뷰
 * 중 유나 발견). 개별 컴포넌트가 아니라 토큰 자체를 L 0.552→0.52로 조정해 시스템 fix했다.
 *
 * 이 스크립트는 `--muted-foreground` × {`--muted`, `--background`, `--card`} × {light, dark}
 * 6쌍을 globals.css 정의 시점에 재계산해 다시 4.5 밑으로 떨어지면 CI에서 잡는다 — #2420
 * AC3(tint-foreground-contrast)와 같은 검증된 oklch→sRGB 변환을 재사용한다(브라우저 불요).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOklchToRgba, compositeOver } from '../src/lib/oklch-contrast';
import { contrastRatio } from '../src/lib/color-contrast';
import { extractCssVarBlock, resolveCssVarValue } from './verify-tint-foreground-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');
const AA_THRESHOLD = 4.5;
const BG_VARS = ['muted', 'background', 'card'] as const;

export interface MutedForegroundContrastResult {
  theme: 'light' | 'dark';
  bgVar: (typeof BG_VARS)[number];
  ratio: number;
}

export function computeMutedForegroundContrasts(css: string): MutedForegroundContrastResult[] {
  const results: MutedForegroundContrastResult[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const pageBgRaw = vars.get('background');
    if (!pageBgRaw) throw new Error(`--background not defined in ${selector}`);
    const pageBg = parseOklchToRgba(resolveCssVarValue(vars, pageBgRaw));
    if (!pageBg) throw new Error(`--background = "${pageBgRaw}" in ${selector} is not a plain oklch()/hex value`);
    const pageBgRgb: [number, number, number] = [pageBg.r, pageBg.g, pageBg.b];

    const fgRaw = vars.get('muted-foreground');
    if (!fgRaw) throw new Error(`--muted-foreground not defined in ${selector}`);
    const fg = parseOklchToRgba(resolveCssVarValue(vars, fgRaw));
    if (!fg) throw new Error(`--muted-foreground = "${fgRaw}" in ${selector} is not a plain oklch()/hex value`);
    const fgOnPage = compositeOver(fg, pageBgRgb);

    for (const bgVar of BG_VARS) {
      const bgRaw = vars.get(bgVar);
      if (!bgRaw) throw new Error(`--${bgVar} not defined in ${selector}`);
      const bg = parseOklchToRgba(resolveCssVarValue(vars, bgRaw));
      if (!bg) throw new Error(`--${bgVar} = "${bgRaw}" in ${selector} is not a plain oklch()/hex value`);
      const bgOnPage = compositeOver(bg, pageBgRgb);
      const ratio = contrastRatio(fgOnPage, bgOnPage);
      results.push({ theme, bgVar, ratio });
    }
  }
  return results;
}

function main(): number {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const results = computeMutedForegroundContrasts(css);

  console.log(`[story #2480] --muted-foreground × {${BG_VARS.join('·')}} × 테마 2 = ${results.length}쌍`);

  let failed = 0;
  for (const r of results) {
    const status = r.ratio >= AA_THRESHOLD ? 'OK' : 'FAIL';
    if (status === 'FAIL') failed += 1;
    console.log(`  ${status === 'OK' ? '✅' : '❌'} ${r.theme}/--${r.bgVar}: muted-foreground on = ${r.ratio.toFixed(2)}`);
  }

  if (failed > 0) {
    console.error(`\n❌ FAIL: ${failed}쌍이 AA(${AA_THRESHOLD}) 미달 — muted-foreground 또는 배경 토큰을 다시 본다.`);
    return 1;
  }
  console.log(`\nOK: 전 조합(${results.length}쌍) AA 통과.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
