/**
 * story #2420 AC4/AC6/AC7 — 「닫힌 계열」의 subtle 알파 배경(bg-<X>/<n>) 재유입 가드.
 *
 * 배경(#2420 본문): 같은 옅은 배경이 bg-<X>/<알파> · bg-<X>-tint 여러 이름으로 흩어져,
 * 문자열 스윕은 이름이 늘 때마다 새 이름을 놓쳤다. 계열별 파일럿이 한 계열의 subtle 알파를
 * 전부 불투명 토큰 bg-<X>-tint로 흡수해 「0」으로 만든 뒤, 그 계열을 이 가드의 CLOSED_FAMILIES에
 * 넣는다. 그 시점부터 그 계열의 subtle 알파(bg-<X>/<n>, n<50)는 재유입 즉시 빨간불이 된다
 * ―「死를 계수 가능하게」(AC6 양성대조: 한 자리를 되돌리면 빨간불).
 *
 * no-new-tint-color-text.ts와의 차이(PO 지적, 2026-09-01) — 그 가드는 알파를 「같은 계열
 * 글자(text-<X>)와 함께」일 때만 잡는다. 순수 bg-<X>/<n>(text 동반 없음)은 못 잡는 갭이 있고,
 * 이 가드가 그 갭을 메운다.
 *
 * CLOSED_FAMILIES는 「그 계열을 0으로 만든 파일럿/팬아웃 PR 안에서」 추가한다 — 아직 알파가
 * 살아 있는 계열을 넣으면 즉시 빨개지므로, 0이 된 시점이 유일하게 옳은 자리다(계약 ③). 그래서
 * baseline 파일이 없다: CLOSED 계열의 기대치는 grandfather 0이 아니라 「완결된 0」이다.
 *
 * 진한 배경 /80·/90(n>=50)은 대상 밖 — 글자가 text-<X>-foreground인 별개 축이다.
 *
 * ⛔정규식을 파일 텍스트 전체에 돌리지 않는다(story #2710 교훈 — 주석/문자열 오독으로 오탐·
 * 미탐이 둘 다 났다). AST(ts.createSourceFile)로 「문자열/템플릿 리터럴」만 뽑아 그 안에서
 * 매칭한다 — 주석 속 bg-<X>/<n> 역사 서술은 리터럴이 아니므로 잡지 않는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** 파일럿이 subtle 알파를 0으로 만든 계열만 넣는다. destructive: story #2420 PR(2026-09-01).
 * warning/info/success는 각 팬아웃 PR이 자기 계열을 0으로 만들 때 그 PR 안에서 추가한다. */
export const CLOSED_FAMILIES = ['destructive'] as const;
export type ClosedFamily = (typeof CLOSED_FAMILIES)[number];

/** n < SUBTLE_MAX 이 subtle tint 대역(각자 적어 넣은 5~30). /80·/90(진한 배경)은 이 위. */
export const SUBTLE_MAX = 50;

export interface AlphaHit {
  family: ClosedFamily;
  token: string;
}

/** 리터럴 하나(따옴표 안 내용물)에서 CLOSED 계열의 subtle 알파 bg 토큰을 찾는다. */
export function findSubtleAlpha(literal: string): AlphaHit[] {
  const hits: AlphaHit[] = [];
  for (const family of CLOSED_FAMILIES) {
    const re = new RegExp(`(?<![\\w-])bg-${family}/(\\d+)(?![\\w-])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(literal)) !== null) {
      if (Number.parseInt(m[1], 10) < SUBTLE_MAX) hits.push({ family, token: m[0] });
    }
  }
  return hits;
}

export interface Violation {
  file: string;
  line: number;
  family: ClosedFamily;
  token: string;
}

/** node가 문자열/템플릿 리터럴이면 그 정적 텍스트를 뽑는다(보간식 내부는 AST 재귀가 따로 방문). */
function literalTextOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)].join(' ');
  }
  return null;
}

/** 가드가 자기 재료(파싱)를 못 읽으면 조용히 건너뛰지 않고 죽는다(story #2710 AC4 동일 계약). */
export function assertParseDiagnosticsReadable(
  file: string,
  parseDiagnostics: readonly ts.Diagnostic[] | undefined,
): void {
  if (parseDiagnostics === undefined) {
    throw new Error(
      `FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심), 확認 필요(story #2710).`,
    );
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일의 문자열 리터럴을 못 읽는다(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4): ` +
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
    if (literal !== null) {
      const hits = findSubtleAlpha(literal);
      if (hits.length > 0) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        for (const hit of hits) violations.push({ file, line, family: hit.family, token: hit.token });
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return violations;
}

const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.[tj]sx?$/;
const MIN_EXPECTED_FILES = 500;

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
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    violations.push(...scanContent(readFileSync(abs, 'utf8'), rel));
  }
  return violations;
}

function main(): number {
  const violations = scanRepo(path.resolve(process.cwd(), 'src'));
  console.log(`닫힌 계열(${CLOSED_FAMILIES.join(', ')})의 subtle 알파 배경(bg-<X>/<n<${SUBTLE_MAX}>) 검사 — 검출 ${violations.length}건`);
  if (violations.length > 0) {
    console.error('\nFAIL: 닫힌 계열의 subtle 알파 배경이 재유입됐다(story #2420 — bg-<X>-tint로 대체하라):');
    for (const v of violations) console.error(`  ${v.file}:${v.line} [${v.family}] "${v.token}"`);
    console.error('\n옅은 계열 배경은 불투명 토큰 bg-<X>-tint를 쓴다(ad-hoc 알파 금지). 진한 배경은 이 가드 대상이 아니다(/80·/90).');
    return 1;
  }
  console.log('\nOK: 닫힌 계열의 subtle 알파 배경 0건.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
