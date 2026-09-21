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
 *
 * 색 규율(story #4100·#4102, PO 결정 2026-09-21 10:45Z — [UX-v3] 토큰 표 §⑥-3):
 * 「상태색·브랜드 색을 다른 계열의 tint/bg 위 «텍스트»로 쓰지 않는다. tint/bg 위 글자는
 * 언제나 text-foreground — 계열 정체성은 border·bg·아이콘으로 전한다.」 brand·primary도
 * 이 가드의 텍스트 축이다(EXTRA_TEXT_COLORS, #4102 AC1 — #4048 text-brand on
 * bg-info-tint 실사고 재현).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const FAMILIES = ['destructive', 'info', 'success', 'warning'] as const;
export type Family = (typeof FAMILIES)[number];

/** story #4102(#4100 유나 定 A안) — brand·primary는 상태색과 달리 자기 pale-bg 계열을
 * ancestor로 흔히 쓰지 않는다(brand·primary는 «강조 텍스트색»으로 주로 쓰임) — 그래서
 * paleBgsIn(조상 pale-bg 탐지)은 FAMILIES 그대로 두고, 이 자리는 TEXT 축만 넓힌다
 * (#4048 text-brand on bg-info-tint 실사고 — 조상은 여전히 기존 4계열, 새로 넓히는 건
 * "그 위에 놓이는 글자색"이 brand·primary여도 잡는지). ancestors.some(strong)이 이미
 * 계열 무관(cross-family)으로 판정하므로 이 배열에 추가하는 것만으로 교차 판정이 켜진다. */
export const EXTRA_TEXT_COLORS = ['brand', 'primary'] as const;
export type TextColor = Family | (typeof EXTRA_TEXT_COLORS)[number];

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

function textFamiliesIn(cls: string): TextColor[] {
  const all: readonly TextColor[] = [...FAMILIES, ...EXTRA_TEXT_COLORS];
  return all.filter(
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
    // story #4126(PO 실측, 2026-09-21) — 정적 literal 조각만 잇고 `${…}` 표현식(삼항·중첩
    // cn() 등)은 버려서 `` `bg-success-tint ${dense ? 'text-muted-foreground' : '…'}` ``
    // 같은 자리를 못 봤다. 각 span의 `.expression`도 같은 함수로 재귀해 literal 조각과
    // 함께 한 문자열로 합친다 — 이 가드의 판정(paleBgsIn/textFamiliesIn)은 부분문자열
    // 존재 검사라, 어느 삼항 branch가 실제로 적용될지 가르지 않고 "나올 수 있는 조각
    // 전부"를 한 문자열에 모아도 검출 정확도는 그대로다(아래 cn()과 동일 근거).
    const exprParts = e.templateSpans.flatMap((sp) => classStringsFromExpr(sp.expression));
    const literalParts = [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)];
    return [[...literalParts, ...exprParts].join(' ')];
  }
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    // story #4126 — 리터럴/무치환 템플릿 인자만 받고 삼항·치환 템플릿·중첩 cn() 인자는
    // 버렸다. 각 인자를 같은 함수로 재귀하면 삼항(ConditionalExpression 갈래)·템플릿
    // (위 갈래, 이제 ${} 재귀 포함)·중첩 cn() 호출(이 갈래 재귀)까지 전부 자연히 커버된다.
    return e.arguments.flatMap((a) => classStringsFromExpr(a));
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

export interface Violation { file: string; line: number; family: TextColor; className: string; }

export function violationKey(v: Pick<Violation, 'file' | 'family' | 'className'>): string {
  return `${v.file}::${v.family}::${v.className}`;
}

// story #4126 CHANGES(PO 확定, 2026-09-21) — doc-status-rail.tsx의 아이콘이 중립
// 불투명 원(bg-background) 위에 있어 조상 pale-bg(bg-warning-tint 등)와 실제로
// 안 겹치는데(§4 의도적 패턴, #2955/#2534/#2420 인용) walk()가 그 사실을 몰라
// 거짓 위반을 냈다 — 이 5개(명시, 넓히지 않기)만 "자기 불투명 배경이 조상 pale을
// 리셋한다"로 인코딩한다. `/N` opacity 접미사가 붙으면(반투명) 매치 안 됨 — 불투명
// 배경만 리셋 자격이 있다.
const NEUTRAL_OPAQUE_BG_RE = /(?<![\w-])bg-(?:background|card|popover|proof-panel|proof-bg)(?![\w/-])/;

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
      // story #4126 CHANGES — 이 요소 자신이 명시 5종 중립 불투명 배경이면, 그 아래
      // 서브트리는 조상 pale-bg와 무관하다(불투명 배경이 시각적으로 그 조상을 완전히
      // 가린다) — 상속된 ancestors까지 포함해 [](완전 리셋)로 넘긴다.
      const nextAncestors = NEUTRAL_OPAQUE_BG_RE.test(cls) ? [] : ancestors.concat(selfPale);
      if (children) for (const c of children) walk(c, nextAncestors);
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
