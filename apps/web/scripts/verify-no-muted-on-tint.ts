/**
 * story #3839(critical·2pt, 카디르 QA 2026-09-14 01:18Z) AC2 — tint 배경(destructive/
 * info/success/warning의 `-tint`/`-bg` 옅은 채움) 서브트리 안 `text-muted-foreground`
 * 정적 재발 방지 가드.
 *
 * 왜 muted가 특별 취급인지: `--muted-foreground`(ink-3, #6E6C67)는 그 짝인 `--muted`
 * (sunk, #F1EFEA) 배경 기준으로 AA 맞춰 조정된 값이다(4.56:1, globals.css §ink-3 주석
 * 근거) — 그러나 family tint(예: info-tint #E7EDF7)는 sunk보다 훨씬 옅어 그 위에선
 * 4.5 밑으로 떨어진다(실측 ≈4.3:1). #4255(알파 합성→solid muted)+#4254(ink-3 v3 값
 * 상향) 조합이 이 구멍을 열었다 — activation-checklist-banner.tsx 3곳이 실사고(PR
 * #4259에 동봉 수정, 이 가드 착지 전에 이미 반영됨).
 *
 * bg-muted 자체는 대상 밖이다(그건 이미 calibrated된 원래 짝 — 위 근거).
 *
 * 자매 가드 verify-cross-element-tint-text.ts(story #2590 A)와 같은 원리(JSX 트리
 * 파싱 + 조상 pale-bg 추적)를 쓰되 대상 클래스가 다르다(계열색 아닌 muted-foreground
 * 정확매치라 size/icon 예외가 불요) — 그 파일은 그대로 두고 별도 스크립트로 낸다
 * (회귀 위험 0, 두 가드 독립 유지).
 *
 * baseline은 verify-no-new-alpha-text-foreground.ts와 동형 관례(카디르 QA 지적,
 * PR#4255 후속) — Set 존재여부가 아니라 `file::muted-on-{family}-tint` → 그 조합의
 * 정확한 발생 개수(Map). 실측이 baseline보다 많으면(신규/증가) FAIL, 적으면(stale,
 * 고쳤는데 목록을 안 뺌) 이것도 FAIL — 정확히 일치해야 GREEN.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;
const MIN_EXPECTED_FILES = 300;

const TINT_FAMILIES = ['destructive', 'info', 'success', 'warning'] as const;
export type TintFamily = (typeof TINT_FAMILIES)[number];

const TINT_FAMILY_BG_RE = new RegExp(
  `(?<![\\w-])bg-(${TINT_FAMILIES.join('|')})-(?:tint|bg)(?:/\\d+)?(?![\\w-])`,
);
const MUTED_TEXT_RE = /(?<![\w-])text-muted-foreground(?![\w-])/;

function classStringsFromExpr(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    return [[e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(' ')];
  }
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    // #2590 A(verify-cross-element-tint-text.ts)와 달리 재귀 처리한다 — 실사고
    // (activation-checklist-banner.tsx)가 정확히 `cn('...', met ? 'a' : 'b')` 형태라,
    // cn() 인자가 문자열 리터럴일 때만 보면 그 삼항이 통째로 빠져 정작 막으려던 자리를
    // 못 잡는다(뮤테이션 테스트가 이 구멍을 실측으로 잡아냈다). 인자별로 재귀해 삼항의
    // 두 branch 모두 수집 — && 등 그 외 조건부는 classStringsFromExpr가 여전히 []로 제외.
    return e.arguments.flatMap((a) => classStringsFromExpr(a));
  }
  if (ts.isConditionalExpression(e)) {
    return [...classStringsFromExpr(e.whenTrue), ...classStringsFromExpr(e.whenFalse)];
  }
  return []; // BinaryExpression(x && 'y') 등 조건부 = 항상적용 보장 안 됨 → 제외(정밀, #2590 A 관례 그대로).
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

export interface Violation { file: string; line: number; family: TintFamily; className: string; }

export function violationKey(v: Pick<Violation, 'file' | 'family'>): string {
  return `${v.file}::muted-on-${v.family}-tint`;
}

export function scanContent(content: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  function walk(node: ts.Node, ancestorFamily: TintFamily | null): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    let children: ts.NodeArray<ts.JsxChild> | null = null;
    if (ts.isJsxElement(node)) { opening = node.openingElement; children = node.children; }
    else if (ts.isJsxSelfClosingElement(node)) { opening = node; }

    if (opening) {
      const cls = classNameStringsOf(opening).join(' ');
      const bgMatch = cls.match(TINT_FAMILY_BG_RE);
      // 같은 요소가 새 tint를 도입하면(같은 요소·직계/深 자식 둘 다 커버) 그 순간부터
      // «유효 조상»을 그 family로 갱신 — 같은 요소 안 bg+text 공존(같은 요소 케이스)도
      // 아래 elementFamily 판정으로 함께 잡힌다.
      const elementFamily: TintFamily | null = (bgMatch?.[1] as TintFamily | undefined) ?? ancestorFamily;
      if (elementFamily && MUTED_TEXT_RE.test(cls)) {
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        violations.push({ file, line, family: elementFamily, className: cls });
      }
      if (children) for (const c of children) walk(c, elementFamily);
      return;
    }
    node.forEachChild((c) => walk(c, ancestorFamily));
  }
  walk(sf, null);
  return violations;
}

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

export function countViolations(violations: Violation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of violations) {
    const key = violationKey(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// story #3839 착수 시점(2026-09-14, PR #4259에 이미 반영된 activation-checklist-banner.tsx
// 3곳은 fix 후라 이 목록에 없다) 레포 전수 스캔(21곳·35건) — 나머지는 이 스토리 스코프 밖
// (화면이 다르고 개별 triage 필요) 기존 채무를 그대로 얼린다. 신규 재유입·증가만 막고,
// 늘어도 줄어도(stale) FAIL — PO 승인 없이 조용히 못 움직인다(no-new-alpha-text-foreground.ts와
// 동형 관례).
export const GRANDFATHER_BASELINE = new Map<string, number>([
  ['app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx::muted-on-info-tint', 1],
  ['app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx::muted-on-destructive-tint', 1],
  ['app/(authenticated)/content/channel-posts/[draftId]/page.tsx::muted-on-destructive-tint', 2],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-info-tint', 1],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-success-tint', 1],
  ['app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx::muted-on-warning-tint', 2],
  ['components/agents/access-matrix-tab.tsx::muted-on-success-tint', 1],
  ['components/ai/ai-generation-loading.tsx::muted-on-info-tint', 4],
  ['components/cage/stuck-handoff-section.tsx::muted-on-destructive-tint', 1],
  ['components/chat/command-hint-notice.tsx::muted-on-info-tint', 1],
  ['components/chat/hitl-approval-card.tsx::muted-on-warning-tint', 3],
  ['components/chat/reference-drop-notice.tsx::muted-on-warning-tint', 2],
  ['components/docs/doc-gate-section.tsx::muted-on-destructive-tint', 1],
  ['components/epics/hypothesis-declaration-card.tsx::muted-on-info-tint', 1],
  ['components/epics/hypothesis-declaration-section.tsx::muted-on-info-tint', 1],
  ['components/hypotheses/hypothesis-verdict-card.tsx::muted-on-success-tint', 5],
  ['components/loops/context-pack-panel.tsx::muted-on-info-tint', 1],
  ['components/retro/sprint-close-cockpit.tsx::muted-on-info-tint', 3],
  ['components/settings/agent-project-access-section.tsx::muted-on-success-tint', 1],
  ['components/sprints/hypothesis-declaration-card.tsx::muted-on-info-tint', 1],
  ['components/sprints/hypothesis-declaration-section.tsx::muted-on-info-tint', 1],
]);

export interface BaselineDrift { key: string; expected: number; got: number; }
export interface BaselineComparison { increased: BaselineDrift[]; stale: BaselineDrift[]; }

/** 순수 함수(no-new-alpha-text-foreground.ts와 동형 관례) — 실측 개수 맵과 baseline 맵을
 * 비교해 「초과(신규/증가)」·「미달(stale)」을 가른다. main()의 파일시스템 스캔과 분리해
 * 스캔 없이 직접 단위 테스트(뮤테이션 표본 포함)할 수 있다. */
export function compareToBaseline(actual: Map<string, number>, baseline: Map<string, number>): BaselineComparison {
  const allKeys = new Set<string>([...actual.keys(), ...baseline.keys()]);
  const increased: BaselineDrift[] = [];
  const stale: BaselineDrift[] = [];
  for (const key of allKeys) {
    const expected = baseline.get(key) ?? 0;
    const got = actual.get(key) ?? 0;
    if (got > expected) increased.push({ key, expected, got });
    else if (got < expected) stale.push({ key, expected, got });
  }
  return { increased, stale };
}

function main(): number {
  const violations = scanRepo(SRC_ROOT);
  const actual = countViolations(violations);
  const { increased, stale } = compareToBaseline(actual, GRANDFATHER_BASELINE);

  const total = [...actual.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[3839] tint 배경 위 text-muted-foreground 스캔 — 고유 자리 ${actual.size}건 · ` +
      `총 발생 ${total}건 · grandfather 등재 ${GRANDFATHER_BASELINE.size}건`,
  );

  if (increased.length === 0 && stale.length === 0) {
    console.log('\nOK: tint 배경 위 text-muted-foreground 개수가 grandfather와 정확히 일치(신규 0·stale 0).');
    return 0;
  }

  if (increased.length > 0) {
    console.error(`\n❌ 신규/증가한 tint-위-muted 자리 ${increased.length}건 — text-foreground로 바꿀 것(story #3839 재발):`);
    for (const h of increased.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.key} (grandfather ${h.expected}건 → 실측 ${h.got}건)`);
    }
  }
  if (stale.length > 0) {
    console.error(`\n❌ stale grandfather ${stale.length}건 — 실제 개수가 등재값보다 적다(고쳤다면 목록에서 개수를 맞출 것):`);
    for (const h of stale.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${h.key} (grandfather ${h.expected}건 → 실측 ${h.got}건)`);
    }
  }
  console.error(
    '\ntint 배경(destructive/info/success/warning -tint·-bg) 위 text-muted-foreground는' +
      ' AA 미달(ink-3는 --muted 배경 기준으로만 조정된 값) — text-foreground를 쓴다(#2420' +
      ' 규율과 같은 축). GRANDFATHER_BASELINE의 개수는 항상 실측과 정확히 일치해야 한다' +
      '(늘어도·줄어도 FAIL — PO 승인 없이 조용히 못 움직인다).',
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
