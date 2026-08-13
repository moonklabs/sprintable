/**
 * story #2590 (A) — «교차-요소» tint 배경 위 계열색 글자 회귀가드(정적 프리필터).
 *
 * 자매 가드 verify-no-new-tint-color-text.ts는 «한 문자열 리터럴 안»의 bg-X+text-X만 본다
 * (findTintTextPairs). 그래서 «부모 요소가 pale bg, 자식 요소가 계열색 글자»(다른 리터럴)인
 * 교차-요소 결함(#2960 hitl-card·#2940 cluster·감사 TIER2 28건)을 구조적으로 못 본다.
 *
 * 이 가드는 ts.createSourceFile로 JSX 트리를 파싱해 «조상 요소의 pale bg»를 정확히 추적하고
 * (regex 조상추적은 복잡 JSX서 오귀속 오탐이 나 폐기) 감사 룩업표의 «측정된 규칙»을 인코딩한다:
 *   ① text-warning + 조상 pale = 항상 결함 (라이트 2.0대·아이콘조차 <3.0, 실측 #2420 doc)
 *   ② text-{success|info|destructive} + 작은글자(<18px·非아이콘) + 강한-tint 조상 = 결함(라이트 <4.5)
 *   제외(오탐 방지): 아이콘(svg/size-only·텍스트자식 없음)·옅은 muted/N 래퍼(4.5+ 통과)·큰글자(≥18px 3.0 통과)
 *
 * (A)는 정적이라 «못 재는» 게 본질이다(그게 (B) axe-core 런타임 가드의 존재이유·최종 authority).
 * (A)가 못 보는 것(AC4 선언): ①`cn(cond && 'bg-tint')`처럼 «항상 적용 보장 안 되는» 조건부 조상
 * ②컴포넌트 경계 넘는 bg(<Alert>·SectionCard 헤더·Button hover-variant) — 다른 파일이라 원리적 불가.
 * 그 자리는 (B) axe가 실 픽셀로 authoritative하게 잡는다. (A)↔(B) 충돌 시 (B) 승.
 * 잔여 오탐의 밸브 = `// tint-guard-ok: <이유>`(이유 필수·grep 가능·안 썩게). 이유 없으면 통과 안 됨.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const FAMILIES = ['destructive', 'info', 'success', 'warning'] as const;
export type Family = (typeof FAMILIES)[number];

interface PaleBg { family: Family | 'muted'; strength: 'strong' | 'weak'; }

function paleBgsIn(cls: string): PaleBg[] {
  const out: PaleBg[] = [];
  for (const fam of FAMILIES) {
    const t = cls.match(new RegExp(`(?<![\\w-])bg-${fam}-(?:tint|bg)(?:/(\\d+))?(?![\\w-])`));
    if (t) out.push({ family: fam, strength: t[1] === undefined ? 'strong' : 'weak' });
    const m = cls.match(new RegExp(`(?<![\\w-])bg-${fam}/(\\d+)(?![\\w-])`));
    if (m) out.push({ family: fam, strength: Number(m[1]) <= 15 ? 'strong' : 'weak' });
  }
  if (/(?<![\w-])bg-muted(?![\w/-])/.test(cls) || /(?<![\w-])bg-muted\/\d+(?![\w-])/.test(cls)) {
    out.push({ family: 'muted', strength: 'weak' });
  }
  return out;
}

function textFamiliesIn(cls: string): Family[] {
  return FAMILIES.filter(
    (fam) =>
      new RegExp(`(?<![\\w-])text-${fam}(?:/\\d+)?(?![\\w-])`).test(cls) &&
      !new RegExp(`text-${fam}-foreground`).test(cls),
  );
}

function isSmallText(cls: string): boolean {
  const px = cls.match(/text-\[(\d+(?:\.\d+)?)px\]/);
  if (px) return Number(px[1]) < 18;
  const rem = cls.match(/text-\[(\d+(?:\.\d+)?)rem\]/);
  if (rem) return Number(rem[1]) * 16 < 18;
  if (/(?<![\w-])text-(xs|sm)(?![\w-])/.test(cls)) return true;
  if (/(?<![\w-])text-(base|lg|xl|\dxl)(?![\w-])/.test(cls)) return false;
  return true; // 크기 미명시 = 상속 = 보수적으로 작은글자 간주
}

/** JSX className 초기자에서 «항상 적용되는» 클래스 문자열들을 뽑는다(정밀·조건부 제외, 단 ternary
 * 양 branch가 «둘 다» pale이면 그 요소는 항상 pale이므로 둘 다 수집). */
function classStringsFromExpr(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    const parts = [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)];
    return [parts.join(' ')];
  }
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    return e.arguments.flatMap((a) =>
      ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? [a.text] : [],
    );
  }
  if (ts.isConditionalExpression(e)) {
    return [...classStringsFromExpr(e.whenTrue), ...classStringsFromExpr(e.whenFalse)];
  }
  return []; // BinaryExpression(x && 'y') 등 조건부 = 항상적용 보장 안 됨 → 제외(정밀)
}

function classNameStringsOf(opening: ts.JsxOpeningLikeElement): string[] {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
      if (ts.isStringLiteral(a.initializer)) return [a.initializer.text];
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
        return classStringsFromExpr(a.initializer.expression);
      }
    }
  }
  return [];
}

export interface Violation { file: string; line: number; family: Family; className: string; }

export function violationKey(v: Pick<Violation, 'file' | 'family' | 'className'>): string {
  return `${v.file}::${v.family}::${v.className}`;
}

function suppressWindows(content: string): { withReason: Set<number>; noReason: Set<number> } {
  const withReason = new Set<number>();
  const noReason = new Set<number>();
  content.split('\n').forEach((ln, i) => {
    const m = ln.match(/(?:\/\/|\/\*|\{\/\*)\s*tint-guard-ok:?([^*}]*)/);
    if (m) {
      const target = m[1].trim().length > 0 ? withReason : noReason;
      target.add(i + 1);
      target.add(i + 2); // 주석 줄 + 다음 줄(같은 줄 trailing / 바로 앞줄 both 커버)
    }
  });
  return { withReason, noReason };
}

export function scanContent(content: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { withReason, noReason } = suppressWindows(content);
  const violations: Violation[] = [];

  const hasDirectText = (node: ts.JsxElement): boolean =>
    node.children.some((c) => ts.isJsxText(c) && /[\w가-힣]/.test(c.text));

  function walk(node: ts.Node, ancestors: PaleBg[]): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    let children: ts.NodeArray<ts.JsxChild> | null = null;
    if (ts.isJsxElement(node)) { opening = node.openingElement; children = node.children; }
    else if (ts.isJsxSelfClosingElement(node)) { opening = node; }

    if (opening) {
      const strings = classNameStringsOf(opening);
      const cls = strings.join(' ');
      const selfPale = strings.flatMap(paleBgsIn);
      const texts = textFamiliesIn(cls);
      if (texts.length > 0 && ancestors.length > 0) {
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        const tag = opening.tagName.getText();
        const sizeOnly = /(?<![\w-])(?:size-\d|h-\d|w-\d)/.test(cls);
        const hasText = ts.isJsxElement(node) ? hasDirectText(node) : false;
        const icon = !hasText && (tag === 'svg' || /^[A-Z]/.test(tag) || sizeOnly);
        for (const fam of texts) {
          const flag =
            fam === 'warning'
              ? true
              : !icon && isSmallText(cls) && ancestors.some((p) => p.strength === 'strong');
          if (!flag || withReason.has(line)) continue;
          if (noReason.has(line)) {
            violations.push({ file, line, family: fam, className: `${cls} [suppress-without-reason]` });
          } else {
            violations.push({ file, line, family: fam, className: cls });
          }
        }
      }
      if (children) for (const c of children) walk(c, ancestors.concat(selfPale));
      return;
    }
    node.forEachChild((c) => walk(c, ancestors));
  }
  walk(sf, []);
  return violations;
}

const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;
const MIN_EXPECTED_FILES = 300;

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function scanRepo(srcRoot: string): Violation[] {
  const files: string[] = [];
  walkDir(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돈다.`);
  }
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    violations.push(...scanContent(readFileSync(abs, 'utf8'), rel));
  }
  return violations;
}

const BASELINE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'cross-element-tint-text-baseline.json',
);

export function loadBaseline(filePath: string): Set<string> {
  try {
    return new Set((JSON.parse(readFileSync(filePath, 'utf8')) as { keys: string[] }).keys);
  } catch {
    return new Set();
  }
}

function main(): number {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const violations = scanRepo(srcRoot);
  const baseline = loadBaseline(BASELINE_PATH);
  const newV = violations.filter((v) => !baseline.has(violationKey(v)));
  const grand = violations.filter((v) => baseline.has(violationKey(v)));

  console.log(`grandfathered baseline: ${baseline.size}건`);
  console.log(`검출 ${violations.length}건(기존 ${grand.length} + 신규 ${newV.length})`);

  if (newV.length > 0) {
    console.error('\nFAIL: baseline에 없는 새 교차-요소 tint×계열색-글자(story #2590):');
    for (const v of newV) console.error(`  ${v.file}:${v.line} [${v.family}] "${v.className}"`);
    console.error(
      '\n조상 pale-bg 위 계열색 글자는 text-foreground를 쓴다(#2420 규칙·계열은 border/bg/아이콘으로).\n' +
        '오탐이면(그 자리를 (B) axe가 통과 판정하면) `// tint-guard-ok: <이유>`로 표시(이유 필수).',
    );
    return 1;
  }
  console.log('\nOK: 새 교차-요소 자리 0건(baseline 초과 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const violations = scanRepo(path.resolve(process.cwd(), 'src'));
    const keys = [...new Set(violations.map(violationKey))].sort();
    process.stdout.write(JSON.stringify({ _comment: 'story #2590 (A) 교차-요소 가드 grandfather baseline — can only shrink', keys }, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
