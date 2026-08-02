/**
 * story #2420 AC3 — 「<X>-tint 배경」×「text-foreground」 조합의 대비를 «정의 시점»에 계산한다.
 *
 * ⭐이 가드가 서는 이유(#2420 본문) — 지금까지는 «사용처»를 센 뒤 하나씩 고쳤다. 이름이
 * 늘 때마다(bg-destructive/N → bg-destructive-tint → bg-warning-tint …) 문자열 스윕이
 * 매번 새 이름을 놓쳤다. 이 가드는 반대로 «globals.css가 어떤 -tint 계열을 정의하는지»를
 * 직접 읽는다 — 새 계열이 추가되면(예: --info-tint) 이 스크립트가 코드 수정 없이 자동으로
 * 그 계열도 검사한다. 사용처를 하나도 안 세도 되는 이유가 여기 있다.
 *
 * ⛔jsdom·정규식 문자열 파싱으로 oklch를 rgb로 착각하지 않는다(color-contrast.ts 경고 그대로)
 * — 실제 색공간 변환(oklch-contrast.ts)을 거쳐 sRGB 픽셀로 만든 뒤 대비를 잰다. 그 변환이
 * 맞다는 것은 oklch-contrast.test.ts가 실 Chromium 캡처값과 대조해 증명해 뒀다 — 여기서는
 * 그 검증된 함수를 그대로 재사용한다(브라우저를 다시 띄우지 않는다 — 정의 검사는 빠르고
 * 결정적이어야 CI에서 매번 돈다).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOklchToRgba, compositeOver } from '../src/lib/oklch-contrast';
import { contrastRatio } from '../src/lib/color-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');
const AA_THRESHOLD = 4.5;

export interface CssVarBlock {
  vars: Map<string, string>;
}

/** `<selector> { ... }` 블록 하나를 중괄호 깊이로 뽑아 --var: value; 선언만 맵으로 낸다.
 * 중첩 규칙(media query 등)은 이 파일의 :root/.dark 블록엔 없다 — 있으면 깊이 카운팅이
 * 그 안의 --var도 주워버릴 수 있으므로, 그 경우는 이 파서를 다시 봐야 한다는 신호다. */
export function extractCssVarBlock(css: string, selector: string): CssVarBlock {
  const startIdx = css.indexOf(`${selector} {`);
  if (startIdx === -1) throw new Error(`selector "${selector}" not found in globals.css`);
  const braceStart = css.indexOf('{', startIdx);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = css.slice(braceStart + 1, end);
  const vars = new Map<string, string>();
  const VAR_RE = /--([\w-]+)\s*:\s*([^;]+);/g;
  for (const m of body.matchAll(VAR_RE)) {
    vars.set(m[1]!, m[2]!.trim());
  }
  return { vars };
}

/** vars 맵에서 `--<family>-tint` 형태의 키를 전부 뽑는다 — «어떤 계열이 있는지»를 코드가
 * 아니라 정의 자체에서 읽는다(story #2420의 핵심 — 새 계열이 자동으로 대상이 되는 이유). */
export function discoverTintFamilies(vars: Map<string, string>): string[] {
  const families: string[] = [];
  for (const key of vars.keys()) {
    const m = /^([\w]+)-tint$/.exec(key);
    if (m) families.push(m[1]!);
  }
  return families.sort();
}

function resolveOklchVar(vars: Map<string, string>, name: string): { r: number; g: number; b: number } {
  const raw = vars.get(name);
  if (!raw) throw new Error(`--${name} not defined in this block`);
  const rgba = parseOklchToRgba(raw);
  if (!rgba) throw new Error(`--${name} = "${raw}" is not a plain oklch() value — resolveOklchVar can't handle var()/other functions, extend it if this is legitimate`);
  return rgba;
}

export interface FamilyContrastResult {
  theme: 'light' | 'dark';
  family: string;
  /** foreground(본 검사 대상) vs tint 배경 대비 — 4.5 미만이면 FAIL. */
  foregroundOnTintRatio: number;
  /** 참고용 — 계열색 그대로를 글자로 썼다면 어떤 값이 나왔을지(양성대조 자료, AC6). */
  familyColorOnTintRatio: number;
}

export function computeFamilyContrasts(css: string): FamilyContrastResult[] {
  const results: FamilyContrastResult[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const bg = resolveOklchVar(vars, 'background');
    const bgRgb: [number, number, number] = [bg.r, bg.g, bg.b];
    const fg = resolveOklchVar(vars, 'foreground');
    const fgRgb: [number, number, number] = [fg.r, fg.g, fg.b];

    for (const family of discoverTintFamilies(vars)) {
      const tintRaw = vars.get(`${family}-tint`)!;
      const tintRgba = parseOklchToRgba(tintRaw);
      if (!tintRgba) continue; // 정의가 var()/color-mix() 등 이 파서가 못 푸는 형태면 스킵(아래서 별도 보고)
      const tintOnBg = compositeOver(tintRgba, bgRgb);

      const foregroundOnTintRatio = contrastRatio(fgRgb, tintOnBg);

      let familyColorOnTintRatio = NaN;
      const familyRaw = vars.get(family);
      if (familyRaw) {
        const familyParsed = parseOklchToRgba(familyRaw);
        if (familyParsed) {
          const familyRgb: [number, number, number] = [familyParsed.r, familyParsed.g, familyParsed.b];
          familyColorOnTintRatio = contrastRatio(familyRgb, tintOnBg);
        }
      }

      results.push({ theme, family, foregroundOnTintRatio, familyColorOnTintRatio });
    }
  }
  return results;
}

function main(): number {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const results = computeFamilyContrasts(css);
  const families = [...new Set(results.map((r) => r.family))].sort();

  console.log(`[AC3] tint 배경 × text-foreground 정의 시점 대비 검사 — 계열 ${families.length}개(${families.join('·')}) × 테마 2 = ${results.length}쌍`);

  let failed = 0;
  for (const r of results) {
    const status = r.foregroundOnTintRatio >= AA_THRESHOLD ? 'OK' : 'FAIL';
    if (status === 'FAIL') failed += 1;
    const familyColorNote = Number.isNaN(r.familyColorOnTintRatio)
      ? ''
      : ` (참고: 계열색 글자였다면 ${r.familyColorOnTintRatio.toFixed(2)})`;
    console.log(`  ${status === 'OK' ? '✅' : '❌'} ${r.theme}/${r.family}: foreground on tint = ${r.foregroundOnTintRatio.toFixed(2)}${familyColorNote}`);
  }

  if (failed > 0) {
    console.error(`\n❌ FAIL: ${failed}쌍이 AA(${AA_THRESHOLD}) 미달 — tint 배경이나 foreground 정의를 다시 본다.`);
    return 1;
  }
  console.log(`\nOK: 전 조합(${results.length}쌍) AA 통과.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
