/**
 * story #3164(DS 게이트 키스톤, doc DS 게이트 키스톤 규격 43ce3a71) — 손코딩 카드(같은
 * className 리터럴 안에 rounded-{lg,xl,2xl}+border+카드표면 bg가 공존하는데 캐노니컬 카드
 * 프리미티브를 안 쓰는 자리)의 «신규 증가»만 막는 baseline-freeze 회귀가드. 캐노니컬
 * 프리미티브 = `Card`/`SectionCard`/`GlassPanel`(components/ui/*)·`cardVariants` cva 함수
 * (components/ui/card.tsx). 사전 스터디 진전 v2 §2b 집행체 — 게이트 부재 축에서 손코딩 카드가
 * 7일간 452→594건으로 늘었다.
 *
 * 기전은 verify-no-new-tint-color-text.ts(story #2420 — 같은 리터럴 안 토큰 공존을 AST로
 * 판정·외부 JSON baseline·self-assert)를 그대로 복제한다(새 기전 발명 금지, PO 지시).
 * `cardVariants()` 호출로 스타일을 얻는 자리는 이 스캐너가 애초에 안 본다 — CallExpression
 * 인자가 아니라 «리터럴 문자열 안의 토큰 공존»만 탐지 대상이라, cva 함수 호출 그 자체는
 * 스캔 대상이 되는 문자열 리터럴이 아니다(구조적으로 자연 제외, 별도 예외 로직 불요).
 *
 * ## 비목표
 * 기존 손코딩 카드 594건을 마이그레이션하지 않는다 — 이 가드는 오직 «더 늘지 않는다»만
 * 보장한다.
 *
 * ⚠️이 가드가 «못 잡는» 것(tint 가드의 한계①②④와 같은 클래스) —
 *   1) split-literal(`cn('rounded-xl', 'border', isActive && 'bg-card')`처럼 세 토큰이 여러
 *      리터럴로 쪼개진 자리)은 "같은 리터럴 안"만 보는 이 스캐너가 못 본다.
 *   2) 동적으로 조립되는 클래스명(변수 보간)은 리터럴 자체에 토큰이 문자열로 없으면 못 잡는다.
 *   3) `rounded border` 표면 자체가 없는 자리(칩/인풋 등)는 애초에 대상 밖 — 카드처럼
 *      보이는데 표면(`bg-card` 등)이 없는 손코딩(예: `border rounded-xl` 뿐)도 대상 밖이다.
 *   4) "0건 증가"는 "전부 깨끗"이 아니라 "새로 늘리지 않았다"일 뿐이다.
 *   5) 기존 594건이 정말 손코딩이어야 마땅한지는 이 가드가 판정하지 않는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 캐노니컬 카드 프리미티브 자신의 구현 파일 — baseline에도 안 실린다(정당한 자리).
export const EXEMPT_FILES = new Set<string>([
  'components/ui/card.tsx',
  'components/ui/section-card.tsx',
  'components/ui/glass-panel.tsx',
  'components/ui/contextual-panel-layout.tsx',
  'components/ui/route-error-state.tsx',
  'components/ui/toast.tsx',
  'components/ui/upgrade-modal.tsx',
]);

// 캐노니컬 카드 JSX 태그명 — 이 태그 자신에 실린 리터럴(예: 중복 스타일 override)은 손코딩이
// 아니라 캐노니컬 위 장식이므로 SAFE(verify-no-handrolled-modal.ts SAFE_PRIMITIVE_TAG와 동형).
const SAFE_CARD_TAGS = new Set(['Card', 'SectionCard', 'GlassPanel']);

const ROUNDED_RE = /(?<![\w-])rounded-(lg|xl|2xl)(?![\w-])/;
const BORDER_RE = /(?<![\w-])border(?![\w-])/;
const CARD_BG_RE = /(?<![\w-])bg-(card|background|muted|popover)(?![\w-])/;

export function isHandrolledCardLiteral(literal: string): boolean {
  return ROUNDED_RE.test(literal) && BORDER_RE.test(literal) && CARD_BG_RE.test(literal);
}

export interface Violation {
  file: string;
  line: number;
  literal: string;
}

/** violation의 안정 키 — 파일+리터럴. 줄 번호는 무관한 편집으로 흔들리므로 키에서 제외
 * (tint 가드 violationKey와 동일 계약). */
export function violationKey(v: Pick<Violation, 'file' | 'literal'>): string {
  return `${v.file}::${v.literal}`;
}

function literalTextOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)].join(' ');
  }
  return null;
}

/** 리터럴 노드에서 위로 올라가 가장 가까운 JSX(Self-closing)Element를 찾아 그 태그명을
 * 반환한다 — className={cn('...')}처럼 CallExpression을 거치는 중첩도 그대로 통과한다
 * (리터럴은 항상 리프라 그 조상 체인에 자기가 속한 엘리먼트가 정확히 하나 있다). */
function enclosingJsxTagName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isJsxOpeningElement(cur) || ts.isJsxSelfClosingElement(cur)) {
      return ts.isIdentifier(cur.tagName) ? cur.tagName.text : null;
    }
    cur = cur.parent;
  }
  return null;
}

// story #2710 AC4와 동일 계약 — 가드가 자기 재료를 못 읽으면 조용한 스킵 대신 죽는다.
export function assertParseDiagnosticsReadable(
  file: string,
  parseDiagnostics: readonly ts.Diagnostic[] | undefined,
): void {
  if (parseDiagnostics === undefined) {
    throw new Error(
      `FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심) — ` +
        `이 가드의 전제(파싱 실패를 스스로 감지할 수 있다는 전제)가 깨졌다, 확認 필요(story #2710 동형).`,
    );
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일의 문자열 리터럴을 ` +
        `못 읽는다(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4 동형): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }
}

export function scanContent(content: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  assertParseDiagnosticsReadable(file, parseDiagnostics);

  const violations: Violation[] = [];
  function walk(node: ts.Node): void {
    const literal = literalTextOf(node);
    if (literal !== null && isHandrolledCardLiteral(literal)) {
      const tag = enclosingJsxTagName(node);
      if (!(tag && SAFE_CARD_TAGS.has(tag))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        violations.push({ file, line, literal });
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return violations;
}

const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;
// .tsx만 스캔(JSX 태그 판정이 필요해 .ts는 대상 밖 — tint 가드의 .ts 포함 스캔과 다른 축).
// 2026-08-28 실측 443개(테스트 제외) — verify-no-handrolled-modal.ts의 380(당시)과 같은
// .tsx-only 축, 여유를 두고 400.
const MIN_EXPECTED_FILES = 400;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

export function scanRepo(srcRoot: string): Violation[] {
  const files: string[] = [];
  walk(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    if (EXEMPT_FILES.has(rel)) continue;
    const content = readFileSync(abs, 'utf8');
    violations.push(...scanContent(content, rel));
  }
  return violations;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'handrolled-card-baseline.json');

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { keys: string[] };
    return new Set(parsed.keys);
  } catch {
    return new Set();
  }
}

function main(): number {
  const violations = scanRepo(SRC_ROOT);
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = violations.filter((v) => !baseline.has(violationKey(v)));
  const grandfathered = violations.filter((v) => baseline.has(violationKey(v)));

  console.log(`grandfathered baseline: ${baseline.size}건`);
  console.log(`검출 ${violations.length}건(baseline 기존 ${grandfathered.length}건 + 신규 ${newViolations.length}건)`);

  const grandfatheredKeys = new Set(grandfathered.map(violationKey));
  const staleBaseline = [...baseline].filter((k) => !grandfatheredKeys.has(k));
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): ${staleBaseline.length}건`);
  }

  if (newViolations.length > 0) {
    console.error('\nFAIL: baseline에 없는 새 손코딩 카드 자리 발견(story #3164 회귀):');
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line} "${v.literal}"`);
    }
    console.error(
      '\nrounded-{lg,xl,2xl}+border+카드표면 bg가 같은 className에 공존하면 손코딩 카드다 — ' +
        '`Card`/`SectionCard`/`GlassPanel`(@/components/ui) 또는 `cardVariants()`를 쓴다. ' +
        '정말 카드가 아닌 정당한 자리라면 PO 승인 후 baseline에 등재.',
    );
    return 1;
  }

  console.log('\nOK: 새 손코딩 카드 자리 0건(baseline 초과 없음 — "전부 깨끗"이 아니라 "안 늘었다"는 뜻).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const violations = scanRepo(SRC_ROOT);
    const keys = [...new Set(violations.map(violationKey))].sort();
    const out = {
      _comment: [
        'story #3164(DS 게이트 키스톤) grandfather baseline — 이 가드 첫 도입 시점 develop의 기존 손코딩 카드.',
        '마이그레이션 대상 아님 — 이 게이트는 "더 늘지 않는다"만 보장한다(freeze, 개별 수리는 후속 표면 리팩터 판).',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
