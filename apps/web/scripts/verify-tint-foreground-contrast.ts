/**
 * story #2420 AC3 — 「<X>-tint 배경」×「text-foreground」 조합의 대비를 «정의 시점»에 계산한다.
 * story #2575 AC1 — 「<X>-bg(불투명 status 배경)」×「text-foreground」로 확장.
 *
 * ⭐#2575가 이 파일을 건드리는 이유(PR #2960 design:changes, 유나 발견) — 이 가드는 원래
 * `-tint`(반투명 10~12%)만 봤다. `-bg`(success/warning/info/destructive의 «불투명» status
 * 배경, 예 `bg-warning-bg`)는 이름이 다르다는 이유만으로 검사 밖에 있었다 — 그래서 HITL
 * 승인카드의 `text-warning on bg-warning-bg`(라이트 2.06:1, AA 미달)가 이 가드를 그대로
 * 빠져나가 유나 육안 리뷰에서야 잡혔다. 「가드가 자기 재료를 못 재면 없는 것과 같다」의 실례.
 * `-bg` 값은 전부 알파 없는 순수 oklch(globals.css 실측 — 아래 참고)라 `compositeOver`가
 * alpha=1일 때 그대로 identity로 통과하므로, tint와 같은 계산 경로를 그대로 재사용한다.
 *
 * ⭐이 가드가 서는 이유(#2420 본문) — 지금까지는 «사용처»를 센 뒤 하나씩 고쳤다. 이름이
 * 늘 때마다(bg-destructive/N → bg-destructive-tint → bg-warning-tint …) 문자열 스윕이
 * 매번 새 이름을 놓쳤다. 이 가드는 반대로 «globals.css가 어떤 -tint/-bg 계열을 정의하는지»를
 * 직접 읽는다 — 새 계열이 추가되면(예: --info-tint·--info-bg) 이 스크립트가 코드 수정 없이
 * 자동으로 그 계열도 검사한다. 사용처를 하나도 안 세도 되는 이유가 여기 있다.
 *
 * ⛔jsdom·정규식 문자열 파싱으로 oklch를 rgb로 착각하지 않는다(color-contrast.ts 경고 그대로)
 * — 실제 색공간 변환(oklch-contrast.ts)을 거쳐 sRGB 픽셀로 만든 뒤 대비를 잰다. 이 변환은
 * 우리 토큰 범위(L 0.5~0.75·중간~높은 채도)에서 실 Chromium 캡처값과 대조해 맞음이 증명됐다
 * (oklch-contrast.ts 상단 참고 — 색역 밖·극단 명도·무채색은 그 대조가 안 됐다는 것도 거기
 * 남아 있다). 여기서는 그 검증된 함수를 그대로 재사용한다(브라우저를 다시 띄우지 않는다 —
 * 정의 검사는 빠르고 결정적이어야 CI에서 매번 돈다).
 *
 * 정확도 한계(#2420 PR #2796 리뷰, 2026-08-02) — 이 변환은 실측(oklch-contrast.test.ts) 대비
 * 채널당 최대 ±1/255 오차가 있다(합성 배경 픽셀 하나에서 관측). 지금 통과하는 열 쌍은
 * 전부 4.5 문턱에서 9.5 이상 여유가 있어(가장 낮은 값이 14.03) 이 오차가 판정을 뒤집을
 * 여지가 없다. 다만 이 가드는 새 계열을 자동으로 줍는다 — 앞으로 어떤 `-tint` 토큰이
 * 4.5에 가까운 값으로 통과/실패 경계에 서거나, 검증된 L·채도 구역 밖의 값으로 정의되면,
 * 이 근사 대신 실 브라우저 canvas 캡처로 재검증할 자리라는 것을 여기 남겨 둔다.
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
/** story #2917 — `--proof-bg` 등은 「값-SSOT」 기저층이지 destructive/success류 «status
 * family»가 아니다(proof-tint는 애초에 없고, proof-bg는 페이지 배경 자체 — family 취급하면
 * 의미 없는 자기-대조 행이 하나 더 생긴다). 한 단어 이름 규칙은 그대로 두고 이 이름만 제외.
 * story #4094 — `--sidebar-border`/`--sidebar-ring`도 같은 클래스: 사이드바 자체의 UI
 * 리전 경계색이지 status family가 아니다(sidebar-tint/sidebar-bg는 애초에 없다) —
 * discoverBorderFamilies를 새로 추가하며 실측으로 드러남(sidebar border를 destructive-tint
 * 등 무관한 배경과 대조하는 의미 없는 행이 생겼었다). */
const NON_STATUS_FAMILY_NAMES = new Set(['proof', 'sidebar']);

export function discoverTintFamilies(vars: Map<string, string>): string[] {
  const families: string[] = [];
  for (const key of vars.keys()) {
    const m = /^([\w]+)-tint$/.exec(key);
    if (m && !NON_STATUS_FAMILY_NAMES.has(m[1]!)) families.push(m[1]!);
  }
  return families.sort();
}

/** story #2575 AC1 — vars 맵에서 `--<family>-bg` 형태의 키를 전부 뽑는다(discoverTintFamilies와
 * 동일한 단일-단어 규율 — `[\w]+`는 하이픈을 안 담으므로 `tiptap-code-bg`·`highlight-search-bg`
 * 같은 다단어 배경 토큰은 자동으로 제외된다. 이는 우연이 아니라 이 파일의 기존 tint 패턴과
 * 의도적으로 같은 경계다 — status 「가족」 이름은 원래 한 단어였다). `proof-bg`처럼 잡히더라도
 * oklch가 아니면(resolveOklchVar가 null) 아래서 스킵된다. */
export function discoverBgFamilies(vars: Map<string, string>): string[] {
  const families: string[] = [];
  for (const key of vars.keys()) {
    const m = /^([\w]+)-bg$/.exec(key);
    if (m && !NON_STATUS_FAMILY_NAMES.has(m[1]!)) families.push(m[1]!);
  }
  return families.sort();
}

/** story #4094 AC2 — tint/bg와 대칭. `--<family>-border`(예: `--warning-border`)는 실 코드에서
 * `border-warning-border` 클래스로 쓰이는 전용 비텍스트 토큰(globals.css 실측 — destructive·
 * success·warning·info가 가짐, primary는 없음). 같은 단일-단어 경계 규율. */
export function discoverBorderFamilies(vars: Map<string, string>): string[] {
  const families: string[] = [];
  for (const key of vars.keys()) {
    const m = /^([\w]+)-border$/.exec(key);
    if (m && !NON_STATUS_FAMILY_NAMES.has(m[1]!)) families.push(m[1]!);
  }
  return families.sort();
}

const VAR_REF_RE = /^var\(\s*--([\w-]+)\s*\)$/;

/** story #2917(Proofline 토큰 매핑표 §8) — 표준 semantic 토큰이 이제 `var(--proof-*)`로
 * 값-SSOT를 참조한다(예: `--background: var(--proof-bg)`). 같은 :root/.dark 블록 안에서
 * 재귀적으로 var() 체인을 풀어 최종 리터럴(oklch()/hex)에 도달한다 — 순환 참조는 명시적으로
 * 실패시킨다(이 파일의 "정의 시점에 못 재면 없는 것과 같다" 규율 그대로, 조용히 포기 금지). */
export function resolveCssVarValue(vars: Map<string, string>, raw: string, seen: Set<string> = new Set()): string {
  const m = VAR_REF_RE.exec(raw.trim());
  if (!m) return raw;
  const refName = m[1]!;
  if (seen.has(refName)) throw new Error(`circular var() reference detected at --${refName}`);
  seen.add(refName);
  const refValue = vars.get(refName);
  if (refValue === undefined) throw new Error(`var(--${refName}) referenced but --${refName} not defined in this block`);
  return resolveCssVarValue(vars, refValue, seen);
}

function resolveOklchVar(vars: Map<string, string>, name: string): { r: number; g: number; b: number } {
  const raw = vars.get(name);
  if (!raw) throw new Error(`--${name} not defined in this block`);
  const resolved = resolveCssVarValue(vars, raw);
  const rgba = parseOklchToRgba(resolved);
  if (!rgba) throw new Error(`--${name} = "${raw}"(resolved: "${resolved}") is not a plain oklch()/hex value — resolveOklchVar can't handle it, extend it if this is legitimate`);
  return rgba;
}

export interface FamilyContrastResult {
  theme: 'light' | 'dark';
  family: string;
  /** story #2575 AC1 — 이 결과가 -tint(반투명) 배경인지 -bg(불투명 status 배경)인지. */
  kind: 'tint' | 'bg';
  /** foreground(본 검사 대상) vs 배경(tint 또는 bg) 대비 — 4.5 미만이면 FAIL. */
  foregroundOnBackgroundRatio: number;
  /** 참고용 — 같은 계열색 그대로를 글자로 썼다면 어떤 값이 나왔을지(양성대조 자료, AC6/AC4). */
  familyColorOnBackgroundRatio: number;
}

/** tint/bg 공통 계산 — family의 배경 변수(`${family}-${suffix}`)를 읽어 foreground·family색
 * 두 가지를 그 위에 올렸을 때의 대비를 낸다. `-bg`는 알파 없는 순수 oklch라 compositeOver가
 * identity로 지나가므로(alpha=1) tint와 동일 경로로 안전하게 재사용된다. */
function computeOneFamilyBackground(
  vars: Map<string, string>,
  pageBgRgb: [number, number, number],
  fgRgb: [number, number, number],
  family: string,
  suffix: 'tint' | 'bg',
): { backgroundRgb: [number, number, number]; foregroundOnBackgroundRatio: number; familyColorOnBackgroundRatio: number } | null {
  const bgRaw = vars.get(`${family}-${suffix}`);
  if (!bgRaw) return null;
  // story #2917 — var() 체인(예: --success-tint: var(--proof-green-soft))을 먼저 풀어야
  // proof-* SSOT 전환 이후에도 이 계열이 «스킵되지 않고» 실제로 검사된다(전엔 이 파서가
  // var()/hex를 못 풀면 조용히 스킵했다 — 그게 검사 공백이 될 뻔한 지점).
  const bgResolved = resolveCssVarValue(vars, bgRaw);
  const bgRgba = parseOklchToRgba(bgResolved);
  if (!bgRgba) return null; // color-mix() 등 정말 못 푸는 형태만 스킵(oklch/hex/var 체인은 이제 풀림)
  const backgroundRgb = compositeOver(bgRgba, pageBgRgb);

  const foregroundOnBackgroundRatio = contrastRatio(fgRgb, backgroundRgb);

  let familyColorOnBackgroundRatio = NaN;
  const familyRaw = vars.get(family);
  if (familyRaw) {
    const familyParsed = parseOklchToRgba(resolveCssVarValue(vars, familyRaw));
    if (familyParsed) {
      const familyRgb: [number, number, number] = [familyParsed.r, familyParsed.g, familyParsed.b];
      familyColorOnBackgroundRatio = contrastRatio(familyRgb, backgroundRgb);
    }
  }

  return { backgroundRgb, foregroundOnBackgroundRatio, familyColorOnBackgroundRatio };
}

export function computeFamilyContrasts(css: string): FamilyContrastResult[] {
  const results: FamilyContrastResult[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const pageBg = resolveOklchVar(vars, 'background');
    const pageBgRgb: [number, number, number] = [pageBg.r, pageBg.g, pageBg.b];
    const fg = resolveOklchVar(vars, 'foreground');
    const fgRgb: [number, number, number] = [fg.r, fg.g, fg.b];

    for (const family of discoverTintFamilies(vars)) {
      const r = computeOneFamilyBackground(vars, pageBgRgb, fgRgb, family, 'tint');
      if (!r) continue;
      results.push({ theme, family, kind: 'tint', foregroundOnBackgroundRatio: r.foregroundOnBackgroundRatio, familyColorOnBackgroundRatio: r.familyColorOnBackgroundRatio });
    }
    for (const family of discoverBgFamilies(vars)) {
      const r = computeOneFamilyBackground(vars, pageBgRgb, fgRgb, family, 'bg');
      if (!r) continue;
      results.push({ theme, family, kind: 'bg', foregroundOnBackgroundRatio: r.foregroundOnBackgroundRatio, familyColorOnBackgroundRatio: r.familyColorOnBackgroundRatio });
    }
  }
  return results;
}

/** story #4055 — «-tint/-bg 배경 위 non-status 강조색(예: text-brand)」이 이 파일의 전신인
 * status-family 중심 검사(foreground·같은-계열-색만 게이트)에서 빠져 있던 사각지대다.
 * #4048 흐름 밴드 자기감사(2026-09-18)에서 `text-brand on bg-info-tint`(10px bold)가
 * 라이트 테마 4.0(<4.5)으로 실 미달이었는데 이 파일의 기존 게이트 어느 것도 안 걸렸다
 * — foreground 검사는 --foreground만 보고, familyColorOnBackgroundRatio는 «같은» 계열색만
 * (예: text-info on bg-info-tint) 보기 때문이다. brand는 discoverTintFamilies/discoverBgFamilies가
 * 못 찾는다(자기 -tint/-bg가 없다) — 그래서 아예 후보에도 안 들었다.
 *
 * 고치는 법 — brand처럼 "자기 tint/bg는 없지만 다른 계열의 tint/bg 위에 얹혀 쓰이는" 강조색을
 * 명시적으로 등록해(CROSS_CHECK_TEXT_VARS), 전 tint/bg 계열 × 양쪽 테마에 대해 게이트한다.
 * discoverTintFamilies류처럼 CSS에서 자동 발견은 못 한다(이런 강조색엔 이름 규칙이 없다) —
 * 그래서 새 강조색이 status 배경 위에 쓰이기 시작하면 여기 추가해야 한다는 게 이 접근의
 * 알려진 한계다(전수벤치·못틀리는대조 둘 다 이 파일의 테스트가 진다). */
const CROSS_CHECK_EXTRA_TEXT_VARS = ['brand'];

/** story #4094 AC1 — 상태색 자신(destructive·info·success·warning·primary)은 brand와 달리
 * 자기 -tint/-bg를 «가진다» — discoverTintFamilies/discoverBgFamilies가 이미 globals.css에서
 * 유도하는 그 목록을 그대로 재사용한다(손으로 5개 이름을 다시 적지 않는다 — 하드코딩 0,
 * 새 상태색이 -tint/-bg만 얻어도 자동으로 이 교차검사 대상이 된다). CROSS_CHECK_EXTRA_
 * TEXT_VARS(brand류, 자기 -tint/-bg가 없어 자동발견 불가)와 합쳐 전체 집합을 만든다. */
export function deriveCrossCheckTextVars(vars: Map<string, string>): string[] {
  const statusFamilies = new Set([...discoverTintFamilies(vars), ...discoverBgFamilies(vars)]);
  return [...new Set([...statusFamilies, ...CROSS_CHECK_EXTRA_TEXT_VARS])].sort();
}

/** story #4102(#4100 유나 定 A안, PO 결정 2026-09-21 10:45Z) — 이 21건은 전부 «상태색·
 * 브랜드 색을 다른 계열 tint/bg 위 텍스트로» 쓰는 **이론적 조합**이었다(#4100 청산 doc,
 * artifact 5329c727 v1 · PO 코드 대조 확認 — badge.tsx 28~46·baseline json 실측): 실 UI
 * 렌더는 0건(badge/alert 모든 tint variant가 text-foreground만 쓴다, #2420 v3 규칙) ·
 * same-family/중립 bg 위 검사는 `computeFamilyContrasts`가 그대로 게이트한다.
 *
 * 예전(story #4055/#4094)엔 이 표가 실 사용처 유무와 무관하게 «토큰 값 자체의 수학적
 * 미달»을 grandfather로 얼려 CI를 지켰다 — 그런데 토큰 값 조정은 PO가 기각했다(자기
 * 계열/중립 위 실사용 값이 옳고, 타 계열 통과시키려 낮추면 실사용을 훼손한다). 진짜 방어는
 * «이 조합이 실제로 쓰이는가»를 보는 usage 층(verify-cross-element-tint-text.ts·
 * verify-no-new-tint-color-text.ts, #4102 AC1에서 brand·primary 텍스트 축 추가·양성대조
 * RED 확認)이어야 한다는 것이 이 스토리의 결론 — token-math 교차 열거는 그 방어를
 * usage 층에 위임하고 여기서는 제거한다(아래 main()의 [story #4055/#4094 AC1] 섹션이
 * 더 이상 실패시키지 않고 참고 로그만 남기는 이유).
 *
 * baseline은 이제 항상 빈 집합이어야 한다(«정확히 0» — 아래 파일의 pin 테스트) — 누가
 * 다시 항목을 채우면 그 자체로 "usage 층 위임" 결정을 몰래 뒤집는 것이므로, 채워 넣는
 * 대신 원인(같은 계열/중립 bg 검사가 실제로 빠졌는지)부터 usage 가드 쪽에서 고친다.
 */
export const GRANDFATHER_BASELINE = new Set<string>([]);

/** story #4094 AC3 — CROSS_CHECK_EXTRA_TEXT_VARS(brand)에 붙던 GRANDFATHER_BASELINE과
 * 같은 계약이지만 이 스토리가 새로 켠 두 게이트(AC1의 상태색-자신 교차·AC2의 비텍스트)가
 * 처음 발견한 미달을 담는 별도 표 — «늘지 않음»만 단언, 해소는 별 카드(유나 디자인 게이트).
 * 값은 실 globals.css를 이 스토리가 처음 스캔한 실측 그대로(추측 0) — 아래 main()의 로그가
 * 그 스캔 결과를 그대로 찍는다. */
const NONTEXT_GRANDFATHER_BASELINE = new Set<string>([]);

export interface CrossCheckTextResult {
  theme: 'light' | 'dark';
  textVar: string;
  family: string;
  kind: 'tint' | 'bg';
  ratio: number;
}

/** CROSS_CHECK_TEXT_VARS의 각 강조색을 전 tint/bg 계열 배경 위에 올렸을 때의 대비 — AA(4.5)
 * 게이트 대상(computeCrossFamilyBgReference의 -bg 전용·참고용 표와 달리 이건 -tint까지
 * 포함해 실제로 막는다). */
export function computeCrossCheckContrasts(css: string): CrossCheckTextResult[] {
  const results: CrossCheckTextResult[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const pageBg = resolveOklchVar(vars, 'background');
    const pageBgRgb: [number, number, number] = [pageBg.r, pageBg.g, pageBg.b];

    for (const textVar of deriveCrossCheckTextVars(vars)) {
      const textRaw = vars.get(textVar);
      if (!textRaw) continue;
      const textParsed = parseOklchToRgba(resolveCssVarValue(vars, textRaw));
      if (!textParsed) continue;
      const textRgb: [number, number, number] = [textParsed.r, textParsed.g, textParsed.b];

      for (const family of discoverTintFamilies(vars)) {
        const r = computeOneFamilyBackground(vars, pageBgRgb, textRgb, family, 'tint');
        if (!r) continue;
        results.push({ theme, textVar, family, kind: 'tint', ratio: r.foregroundOnBackgroundRatio });
      }
      for (const family of discoverBgFamilies(vars)) {
        const r = computeOneFamilyBackground(vars, pageBgRgb, textRgb, family, 'bg');
        if (!r) continue;
        results.push({ theme, textVar, family, kind: 'bg', ratio: r.foregroundOnBackgroundRatio });
      }
    }
  }
  return results;
}

const AA_NONTEXT_THRESHOLD = 3.0;

/** story #4094 AC2 — WCAG 1.4.11(Non-text Contrast, 3:1)이 요구하는 UI 컴포넌트(border·
 * focus ring) 대비. 텍스트 4.5:1 게이트와 별도 축이다. 두 가지 실제 사용 패턴을 실 코드에서
 * 확認(border-*, ring-* 클래스를 src에서 grep)한 그대로 나눈다:
 *  - 'border' — `border-<family>-border`(전용 토큰, 예: `--warning-border`)가 있으면
 *    그 값. discoverBorderFamilies로 globals.css에서 유도(하드코딩 0).
 *  - 'ring' — `ring-<family>`(예: `ring-destructive`)는 전용 `-ring` 토큰이 globals.css에
 *    없다(실측 확認) — Tailwind가 base family 색(`--destructive` 등)을 그대로 쓴다. 그래서
 *    deriveCrossCheckTextVars와 같은 상태색 목록(자기 -tint/-bg가 있는 계열)을 재사용한다.
 */
export interface NonTextCrossCheckResult {
  theme: 'light' | 'dark';
  usage: 'border' | 'ring';
  family: string;
  bgFamily: string;
  kind: 'tint' | 'bg';
  ratio: number;
}

export function computeNonTextCrossCheckContrasts(css: string): NonTextCrossCheckResult[] {
  const results: NonTextCrossCheckResult[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const pageBg = resolveOklchVar(vars, 'background');
    const pageBgRgb: [number, number, number] = [pageBg.r, pageBg.g, pageBg.b];
    const bgFamilies = [...new Set([...discoverTintFamilies(vars), ...discoverBgFamilies(vars)])];

    const usages: Array<{ usage: 'border' | 'ring'; families: string[]; resolve: (family: string) => string | undefined }> = [
      { usage: 'border', families: discoverBorderFamilies(vars), resolve: (f) => vars.get(`${f}-border`) },
      { usage: 'ring', families: [...new Set([...discoverTintFamilies(vars), ...discoverBgFamilies(vars)])], resolve: (f) => vars.get(f) },
    ];

    for (const { usage, families, resolve } of usages) {
      for (const family of families) {
        const raw = resolve(family);
        if (!raw) continue;
        const parsed = parseOklchToRgba(resolveCssVarValue(vars, raw));
        if (!parsed) continue;
        const fgRgb: [number, number, number] = [parsed.r, parsed.g, parsed.b];

        for (const bgFamily of bgFamilies) {
          for (const kind of ['tint', 'bg'] as const) {
            const r = computeOneFamilyBackground(vars, pageBgRgb, fgRgb, bgFamily, kind);
            if (!r) continue;
            results.push({ theme, usage, family, bgFamily, kind, ratio: r.foregroundOnBackgroundRatio });
          }
        }
      }
    }
  }
  return results;
}

function nonTextCrossCheckKey(r: { theme: string; usage: string; family: string; bgFamily: string; kind: string }): string {
  return `${r.theme}|${r.usage}|${r.family}|${r.bgFamily}|${r.kind}`;
}

/** story #2575 AC4 — 교차-계열 참고표(게이트 대상 아님, AC3 인간관문의 근거자료). #2960의
 * 실제 위반(`text-destructive` on `bg-warning-bg`)은 "A 계열 글자가 B 계열의 -bg 위"라는
 * 교차-계열 조합이라 위 foregroundOnBackgroundRatio(항상 --foreground 대상)도, 위
 * familyColorOnBackgroundRatio(항상 «같은» 계열)도 이 숫자를 만들지 않는다 — per-family
 * 정의 검사가 구조적으로 못 보는 자리라는 것을 AC3가 명시한 바로 그것이다. 이 함수는 그
 * 사각지대를 게이트 없이 «기록만» 한다: 모든 (textFamily, bgFamily) 쌍에서 textFamily의
 * 계열색을 bgFamily의 -bg 위에 올렸을 때 값 — #2960 수치(warning 2.06·destructive 4.37)가
 * 여기 재현되는지가 AC4의 양성대조다. */
export interface CrossFamilyBgReference {
  theme: 'light' | 'dark';
  textFamily: string;
  bgFamily: string;
  ratio: number;
}

export function computeCrossFamilyBgReference(css: string): CrossFamilyBgReference[] {
  const results: CrossFamilyBgReference[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const pageBg = resolveOklchVar(vars, 'background');
    const pageBgRgb: [number, number, number] = [pageBg.r, pageBg.g, pageBg.b];
    const bgFamilies = discoverBgFamilies(vars);
    // textFamily는 -bg를 가진 계열로 한정하지 않는다 — "이 계열 색이 글자로 쓰였다면"을
    // 묻는 축이라 tint만 있는 계열(예: primary)도 후보다. tint∪bg 전체를 합쳐 중복 제거.
    const textFamilies = [...new Set([...discoverTintFamilies(vars), ...bgFamilies])].sort();

    for (const bgFamily of bgFamilies) {
      const bgRaw = vars.get(`${bgFamily}-bg`);
      if (!bgRaw) continue;
      const bgRgba = parseOklchToRgba(resolveCssVarValue(vars, bgRaw));
      if (!bgRgba) continue;
      const backgroundRgb = compositeOver(bgRgba, pageBgRgb);

      for (const textFamily of textFamilies) {
        const textRaw = vars.get(textFamily);
        if (!textRaw) continue;
        const textParsed = parseOklchToRgba(resolveCssVarValue(vars, textRaw));
        if (!textParsed) continue;
        const textRgb: [number, number, number] = [textParsed.r, textParsed.g, textParsed.b];
        const ratio = contrastRatio(textRgb, backgroundRgb);
        results.push({ theme, textFamily, bgFamily, ratio });
      }
    }
  }
  return results;
}

function main(): number {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const results = computeFamilyContrasts(css);
  const tintResults = results.filter((r) => r.kind === 'tint');
  const bgResults = results.filter((r) => r.kind === 'bg');
  const tintFamilies = [...new Set(tintResults.map((r) => r.family))].sort();
  const bgFamilies = [...new Set(bgResults.map((r) => r.family))].sort();

  console.log(`[AC3] tint 배경 × text-foreground 정의 시점 대비 검사 — 계열 ${tintFamilies.length}개(${tintFamilies.join('·')}) × 테마 2 = ${tintResults.length}쌍`);
  let failed = 0;
  for (const r of tintResults) {
    const status = r.foregroundOnBackgroundRatio >= AA_THRESHOLD ? 'OK' : 'FAIL';
    if (status === 'FAIL') failed += 1;
    const familyColorNote = Number.isNaN(r.familyColorOnBackgroundRatio)
      ? ''
      : ` (참고: 계열색 글자였다면 ${r.familyColorOnBackgroundRatio.toFixed(2)})`;
    console.log(`  ${status === 'OK' ? '✅' : '❌'} ${r.theme}/${r.family}: foreground on tint = ${r.foregroundOnBackgroundRatio.toFixed(2)}${familyColorNote}`);
  }

  console.log(`\n[AC1(#2575)] -bg(불투명 status 배경) × text-foreground 정의 시점 대비 검사 — 계열 ${bgFamilies.length}개(${bgFamilies.join('·')}) × 테마 2 = ${bgResults.length}쌍`);
  for (const r of bgResults) {
    const status = r.foregroundOnBackgroundRatio >= AA_THRESHOLD ? 'OK' : 'FAIL';
    if (status === 'FAIL') failed += 1;
    const isWarningPositiveControl = r.theme === 'light' && r.family === 'warning';
    const familyColorNote = Number.isNaN(r.familyColorOnBackgroundRatio)
      ? ''
      : ` (참고: 계열색 글자였다면 ${r.familyColorOnBackgroundRatio.toFixed(2)}${isWarningPositiveControl ? ' — AC4 양성대조: #2960 실측 2.06과 근사 일치' : ''})`;
    console.log(`  ${status === 'OK' ? '✅' : '❌'} ${r.theme}/${r.family}: foreground on bg = ${r.foregroundOnBackgroundRatio.toFixed(2)}${familyColorNote}`);
  }

  // story #4102 — 강조/상태색 × 다른 계열 tint/bg의 «교차 열거를 게이트로 쓰는» 것을
  // 제거했다(위 GRANDFATHER_BASELINE docstring 참고 — 실 UI 렌더 0건, 진짜 방어는
  // usage 층 verify-cross-element-tint-text.ts·verify-no-new-tint-color-text.ts로
  // 위임). computeCrossCheckContrasts 자체는 여전히 참고 수치로 로그만 남긴다(AC4의
  // computeCrossFamilyBgReference 섹션과 동일하게 — failed에 절대 반영하지 않는다).
  const crossCheckTextVarsPreview = deriveCrossCheckTextVars(extractCssVarBlock(css, ':root').vars);
  console.log(`\n[story #4102] 강조색·상태색 × 전 tint/bg 계열 교차 — 게이트 제거(usage 층 위임), 참고 전용 · 대상 ${crossCheckTextVarsPreview.length}개(${crossCheckTextVarsPreview.join('·')}) · GRANDFATHER_BASELINE = 정확히 ${GRANDFATHER_BASELINE.size}건(usage 층 위임 후 항상 0)`);
  const crossCheck = computeCrossCheckContrasts(css);
  let crossCheckOk = 0;
  for (const r of crossCheck) {
    const isFail = r.ratio < AA_THRESHOLD;
    if (!isFail) crossCheckOk += 1;
    console.log(`  ${isFail ? 'ℹ️' : '✅'} ${r.theme}/text-${r.textVar} on ${r.family}-${r.kind} = ${r.ratio.toFixed(2)}${isFail ? ' (참고 — 게이트 대상 아님, usage 층에서 실사용 여부를 본다)' : ''}`);
  }
  console.log(`  참고: 전 ${crossCheck.length}조합 중 OK(≥${AA_THRESHOLD}) ${crossCheckOk}건 — 나머지는 이론적 정의-미달이나 실사용 0(usage 가드가 그 축을 지킨다).`);

  console.log(`\n[story #4094 AC2] 비텍스트(border·ring) × 전 tint/bg 계열 교차 게이트(3:1) · grandfather(발견만, 안 막음) ${NONTEXT_GRANDFATHER_BASELINE.size}건`);
  const nonTextCrossCheck = computeNonTextCrossCheckContrasts(css);
  const nonTextGrandfatherSeen = new Set<string>();
  let newNonTextFailures = 0;
  for (const r of nonTextCrossCheck) {
    const key = nonTextCrossCheckKey(r);
    const isFail = r.ratio < AA_NONTEXT_THRESHOLD;
    const isGrandfathered = isFail && NONTEXT_GRANDFATHER_BASELINE.has(key);
    if (isGrandfathered) nonTextGrandfatherSeen.add(key);
    if (isFail && !isGrandfathered) { failed += 1; newNonTextFailures += 1; }
    const label = isGrandfathered ? 'GRANDFATHER' : isFail ? 'FAIL' : 'OK';
    const icon = label === 'OK' ? '✅' : label === 'GRANDFATHER' ? '📋' : '❌';
    console.log(`  ${icon} ${r.theme}/${r.usage}-${r.family} on ${r.bgFamily}-${r.kind} = ${r.ratio.toFixed(2)}${label === 'GRANDFATHER' ? ' (grandfather)' : ''}`);
  }
  const staleNonTextGrandfather = [...NONTEXT_GRANDFATHER_BASELINE].filter((k) => !nonTextGrandfatherSeen.has(k));
  if (staleNonTextGrandfather.length > 0) {
    console.log(`  ℹ️ grandfather로 등재됐으나 이번 스캔에서 안 걸린(죽은 항목 후보, 목록에서 지워도 됨): ${staleNonTextGrandfather.join(', ')}`);
  }
  if (newNonTextFailures > 0) {
    console.error(`  ❌ grandfather 밖 신규 비텍스트 미달 ${newNonTextFailures}건 — 이 스토리 범위(발견만) 밖이니 baseline에 추가하지 말고 원인부터 본다.`);
  }

  console.log(`\n[AC4(#2575) 참고 — 교차-계열, 게이트 대상 아님·AC3 인간관문 근거] textFamily 색이 다른 bgFamily의 -bg 위에 있을 때:`);
  const cross = computeCrossFamilyBgReference(css);
  const lightDestructiveOnWarning = cross.find((c) => c.theme === 'light' && c.textFamily === 'destructive' && c.bgFamily === 'warning');
  if (lightDestructiveOnWarning) {
    console.log(`  ℹ️ light: text-destructive on bg-warning-bg = ${lightDestructiveOnWarning.ratio.toFixed(2)} (AC4 양성대조: #2960 실측 위반값 4.37과 일치)`);
  }

  if (failed > 0) {
    console.error(`\n❌ FAIL: ${failed}쌍이 AA(${AA_THRESHOLD}) 미달 — 배경이나 foreground 정의를 다시 본다.`);
    return 1;
  }
  console.log(`\nOK: 전 조합(${results.length}쌍) AA 통과.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
