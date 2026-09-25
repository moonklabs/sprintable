/**
 * story #4315(PO 2026-09-25 · high) — 밝은 테마 문서 본문 링크가 1.25:1이었다. 뿌리: 문서 렌더러의 `[&_a]:text-brand-soft` —
 * `--brand-soft`는 옅은 **틴트**(배경 · 칩 채움)용 토큰인데 글자색으로 썼다(어두운 테마에선 밝은 값이라 10.48로 읽혀 못 봤다).
 * 같은 모양이 문서 편집기 칩 · 정책 문서 목록 · 페이지 임베드 등 11곳에 있었다 → 테마별로 읽히는 글자 토큰 `--brand-text`
 * (밝은 = brand-strong · 어두운 = brand-soft)로 모았다.
 *
 * 두 축을 잰다:
 *   (a) 토큰 대비 — `--brand-text` vs 페이지 배경 · 카드 · 카드 위 brand/14 틴트(활성 칩) ≥ 4.5:1(본문 글자 AA) · 양 테마.
 *   (b) 사용처 — `brand-soft`를 **글자색**으로 쓰는 자리 0(`text-brand-soft` · `text-[color:var(--brand-soft)]` · CSS `color: var(--brand-soft)`).
 *       `dark:` 변형 안에서만 쓰는 것은 허용(어두운 테마에선 읽힌다). 틴트(`bg-` · `border-` …)는 대상 아님.
 *
 * ⚠️ 못 잡는 것: 다른 옅은 토큰(예: `--brand-contrast`)을 글자로 쓰는 것 · 인라인 style 객체 · 런타임 조합 문자열.
 * oklch→sRGB · 대비 계산은 verify-accent-color-contrast.ts와 같은 유틸(실 Chromium 캡처 대조 완료)을 재사용한다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCssVarBlock, resolveCssVarValue } from './verify-tint-foreground-contrast';
import { parseOklchToRgba } from '../src/lib/oklch-contrast';
import { contrastRatio } from '../src/lib/color-contrast';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS_PATH = path.resolve(HERE, '../src/app/globals.css');
const SRC_ROOT = path.resolve(HERE, '../src');
const AA_TEXT = 4.5;
/** 활성 칩 모양(`bg-brand/14 text-brand-text`)의 틴트 알파 — 이 저장소에서 브랜드 글자를 얹는 가장 진한 틴트. */
const CHIP_TINT_ALPHA = 0.14;

type Rgb = [number, number, number];

function resolveRgb(vars: Map<string, string>, name: string): Rgb {
  const raw = vars.get(name);
  if (!raw) throw new Error(`--${name} not defined in this block`);
  const resolved = resolveCssVarValue(vars, raw);
  const rgba = parseOklchToRgba(resolved);
  if (!rgba) throw new Error(`--${name} = "${raw}"(resolved: "${resolved}") is not a plain oklch()/hex value`);
  return [rgba.r, rgba.g, rgba.b];
}

/** 브라우저 기본 합성(sRGB 공간 알파 블렌딩). */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i]! + (1 - alpha) * bg[i]!) as Rgb;
}

export interface BrandTextContrast {
  theme: 'light' | 'dark';
  onBackground: number;
  onCard: number;
  onChipTint: number;
}

export function computeBrandTextContrasts(css: string): BrandTextContrast[] {
  const out: BrandTextContrast[] = [];
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const { vars } = extractCssVarBlock(css, selector);
    const text = resolveRgb(vars, 'brand-text');
    const background = resolveRgb(vars, 'background');
    const card = resolveRgb(vars, 'card');
    const brand = resolveRgb(vars, 'brand');
    out.push({
      theme,
      onBackground: contrastRatio(text, background),
      onCard: contrastRatio(text, card),
      onChipTint: contrastRatio(text, over(brand, card, CHIP_TINT_ALPHA)),
    });
  }
  return out;
}

export interface BrandSoftTextUse {
  file: string;
  line: number;
  text: string;
}

// 글자색 모양 셋. 앞에 붙은 변형 사슬(`hover:` · `[&_a]:` · `dark:` …)을 같이 잡아 `dark:`가 있는지 본다.
const CLASS_RE = /(?<![\w-])((?:[\w&[\]_>*().:-]+?:)*)text-(?:brand-soft|\[color:var\(--brand-soft\)\])(?![\w-])/g;
const CSS_RE = /(?<![\w-])color\s*:\s*var\(--brand-soft\)/g;

export function findBrandSoftTextUses(content: string, file: string): BrandSoftTextUse[] {
  const hits: BrandSoftTextUse[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    CLASS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLASS_RE.exec(line)) !== null) {
      const variants = m[1] ?? '';
      if (/(^|:)dark:/.test(variants) || variants.startsWith('dark:')) continue; // 어두운 테마 전용 — 읽힌다.
      hits.push({ file, line: i + 1, text: line.trim() });
    }
    if (file.endsWith('.css')) {
      CSS_RE.lastIndex = 0;
      if (CSS_RE.test(line)) hits.push({ file, line: i + 1, text: line.trim() });
    }
  });
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(full, out);
    } else if (/\.(tsx?|css)$/.test(entry) && !/\.test\.[tj]sx?$/.test(entry)) {
      out.push(full);
    }
  }
}

const MIN_EXPECTED_FILES = 400;

export function scanRepo(srcRoot: string): BrandSoftTextUse[] {
  const files: string[] = [];
  walk(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돈다.`);
  return files.flatMap((abs) => findBrandSoftTextUses(readFileSync(abs, 'utf8'), path.relative(srcRoot, abs).split(path.sep).join('/')));
}

function main(): number {
  let failed = false;
  const contrasts = computeBrandTextContrasts(readFileSync(GLOBALS_CSS_PATH, 'utf8'));
  console.log('[story #4315] 브랜드 글자(--brand-text) 대비 —');
  for (const c of contrasts) {
    console.log(`  ${c.theme}: 배경 ${c.onBackground.toFixed(2)} · 카드 ${c.onCard.toFixed(2)} · 카드 위 brand/${Math.round(CHIP_TINT_ALPHA * 100)} 틴트 ${c.onChipTint.toFixed(2)}`);
    for (const [label, v] of [['배경', c.onBackground], ['카드', c.onCard], ['칩 틴트', c.onChipTint]] as const) {
      if (v < AA_TEXT) { console.error(`FAIL: ${c.theme} --brand-text vs ${label} ${v.toFixed(2)} < ${AA_TEXT}:1`); failed = true; }
    }
  }
  const uses = scanRepo(SRC_ROOT);
  if (uses.length > 0) {
    failed = true;
    console.error(`\n❌ brand-soft를 글자색으로 쓰는 자리 ${uses.length}곳 — 옅은 틴트 토큰이라 밝은 테마에서 1.1~1.35:1. text-brand-text로:`);
    for (const u of uses) console.error(`  - ${u.file}:${u.line}: ${u.text.slice(0, 160)}`);
  } else {
    console.log('  brand-soft 글자색 사용처 0(dark: 전용 제외).');
  }
  if (failed) return 1;
  console.log('OK');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
