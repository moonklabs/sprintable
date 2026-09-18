/**
 * story #3925(§⑤ 낱말 드리프트) — CSS `uppercase` 클래스가 ko.json 원본 문자열을 화면에서만
 * 대문자로 그리는 자리를 잡는다. 두 ASCII 가드(verify-no-ascii-token-in-ko-value.ts 축1
 * CAPS·축2 whole-value)는 **원본 문자열 자체**를 기준으로 보기 때문에, ko 값이 소문자/
 * Title-Case 영문이어도 `uppercase` 클래스가 화면에서 대문자로 바꿔치는 자리는 구조적으로
 * 못 본다 — 실 사고: `attentionQueue.kicker`="오늘 · Attention Queue"(원본은 Title Case)가
 * `attention-queue-view.tsx:179`의 `uppercase` 클래스로 "오늘 · ATTENTION QUEUE"로 노출됐는데
 * 두 ASCII 가드 다 통과였다(story #3925 조사, 2026-09-15).
 *
 * ## 기전 — AST(verify-no-raw-ascii-jsx-text.ts와 동형, 새 기전 발명 금지)
 * `apps/web/src` 전수(.tsx, 테스트 제외)를 walk — JSX 엘리먼트의 여는 태그 `className`
 * 소스 텍스트에 "uppercase" 부분문자열이 있으면, 그 엘리먼트의 자식 서브트리에서
 * `{t('key')}`류 호출(바인딩된 변수명 — `useTranslations('ns')` 스코프 해석은
 * verify-no-i18n-phrase-collision.ts의 parseTranslationBindings 재사용, 새 기전 발명 금지)을
 * 찾아 `namespace.key`로 정규화한다. 그 키의 ko.json 값에 라틴 문자(`[A-Za-z]`)가 하나라도
 * 있으면 위반.
 *
 * ## 이 가드가 «못 잡는» 것(선언 — AC3880 계열 관례)
 * - `className`이 동적으로 조립되는 자리(`cn(x, condition && 'uppercase')`처럼 조건부로만
 *   붙는 경우)는 소스 텍스트에 "uppercase" 리터럴이 있으면 잡히지만, 클래스명 자체가 런타임
 *   변수로 조립되면(`className={styles.eyebrow}`) 못 본다 — 정적 분석의 본질적 한계.
 * - `t('key')`가 아니라 다른 변수에 담겨 나중에 렌더되는 간접 자리(`const label = t('key');
 *   return <div className="uppercase">{label}</div>`)는 자식 서브트리에 호출이 없어 못 잡는다.
 * - en.json은 대상 밖(원문이 영어라 대문자 변형이 당연 — ko 로케일에서만 "원본이 소문자인데
 *   화면은 대문자"가 성립).
 *
 * ## baseline(1건, shrink-only) + ALLOWLIST(4건, 영구)
 * - ALLOWLIST — story #3880 PO 確定(2026-09-14) proof-단계 스탬프 액센트(goals 4개) — §⑤가
 *   허용하는 디자인 의도, 번역 대상 아님.
 * - baseline — `attentionQueue.kicker` 1건만: story #3920(유나)이 "오늘"로 전환 중(이 가드
 *   착수 시점엔 아직 develop에 안 착지) — PO 지시(2026-09-15 09:43Z)대로 정확히 1건으로
 *   시작, shrink-only(#3920이 먼저 착지하면 이 baseline은 stale이 되어 가드가 FAIL — 그때
 *   0으로 비운다). 새로 늘어나는 건 절대 허용하지 않는다(baseline은 "지금 실재하는 잔존"만).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseTranslationBindings } from './verify-no-i18n-phrase-collision';

export interface UppercaseEyebrowRef {
  file: string;
  line: number;
  key: string;
  value: string;
}

const LATIN_RE = /[A-Za-z]/;
// 플레이스홀더({n}·{org} 등)는 렌더 시 데이터로 치환돼 화면에 리터럴 영문으로 남지 않는다 —
// 변수명 자체(예: "org")가 값 안에 우연히 라틴 문자를 담고 있어도 "노출된 영문"이 아니다.
const PLACEHOLDER_RE = /\{[^}]*\}/g;

function getClassNameText(
  openingElement: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): string | null {
  for (const attr of openingElement.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'className' && attr.initializer) {
      return attr.initializer.getText(sf);
    }
  }
  return null;
}

function findTCalls(
  node: ts.Node,
  sf: ts.SourceFile,
  bindings: ReadonlyMap<string, string>,
  out: { varName: string; key: string; line: number }[],
): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.has(node.expression.text)) {
    const arg0 = node.arguments[0];
    if (arg0 && ts.isStringLiteral(arg0)) {
      out.push({
        varName: node.expression.text,
        key: arg0.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
  }
  node.forEachChild((c) => findTCalls(c, sf, bindings, out));
}

export function scanContentForEyebrows(
  content: string,
  file: string,
): { file: string; line: number; key: string }[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings = parseTranslationBindings(content);
  const found: { file: string; line: number; key: string }[] = [];

  function walk(node: ts.Node): void {
    let openingEl: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
    let childScanRoot: ts.Node | null = null;
    if (ts.isJsxElement(node)) {
      openingEl = node.openingElement;
      childScanRoot = node;
    } else if (ts.isJsxSelfClosingElement(node)) {
      openingEl = node;
    }
    if (openingEl && childScanRoot) {
      const cls = getClassNameText(openingEl, sf);
      if (cls && cls.includes('uppercase')) {
        const calls: { varName: string; key: string; line: number }[] = [];
        findTCalls(childScanRoot, sf, bindings, calls);
        for (const c of calls) {
          const ns = bindings.get(c.varName);
          if (ns) found.push({ file, line: c.line, key: `${ns}.${c.key}` });
        }
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return found;
}

function walkTsxFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsxFiles(full, out);
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
}

const MIN_EXPECTED_TSX_FILES = 300;

export function flattenKo(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of flattenKo(v as Record<string, unknown>, key)) flat.set(kk, vv);
    } else if (typeof v === 'string') {
      flat.set(key, v);
    }
  }
  return flat;
}

export function scanRepo(srcRoot: string, koJson: Record<string, unknown>): UppercaseEyebrowRef[] {
  const files: string[] = [];
  walkTsxFiles(srcRoot, files);
  if (files.length < MIN_EXPECTED_TSX_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const koFlat = flattenKo(koJson);
  const refs: UppercaseEyebrowRef[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    for (const eb of scanContentForEyebrows(content, rel)) {
      const value = koFlat.get(eb.key);
      if (value !== undefined) {
        refs.push({ file: eb.file, line: eb.line, key: eb.key, value });
      }
    }
  }
  return refs;
}

/** 라틴 문자가 있는 것만 위반 후보(전체 eyebrow 자리 수와는 다른 수 — main()에서 둘 다 로그). */
export function latinViolations(refs: readonly UppercaseEyebrowRef[]): UppercaseEyebrowRef[] {
  return refs.filter((r) => LATIN_RE.test(r.value.replace(PLACEHOLDER_RE, '')));
}

export function refKey(r: Pick<UppercaseEyebrowRef, 'key'>): string {
  return r.key;
}

// ALLOWLIST — 영구 예외. story #3880 PO 確定(2026-09-14) — 목표 상세 eyebrow 3 + 목표 목록
// 킥커는 "한국어 낱말 · 영문 대문자 proof-단계 스탬프" 패턴이 §⑤가 허용하는 액센트(증명
// 시스템 시그니처, 내부어 누출 아님).
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'goals.taskCapsuleTitle',
  'goals.outcomeCapsuleTitle',
  'goals.indexKicker',
  'goals.trustRailTitle',
  // canvas.exportPngUnavailableForHtml — PNG·HTML은 verify-no-ascii-token-in-ko-value.ts
  // TOKEN_ALLOWLIST에 이미 등재된 파일형식 이니셜리즘(같은 근거: 프로토콜/표준 고유명,
  // 어느 언어든 번역 대상 아님) — 이 가드에서 재등재만, 새 판단 아님.
  'canvas.exportPngUnavailableForHtml',
]);

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'latin-in-uppercase-eyebrow-baseline.json',
);

interface BaselineFile {
  _comment: string[];
  keys: string[];
}

export function loadKoJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

export function loadBaseline(filePath: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as BaselineFile;
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

export function computeNewViolations(
  refs: readonly UppercaseEyebrowRef[],
  allowlist: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
): UppercaseEyebrowRef[] {
  return latinViolations(refs).filter((r) => !allowlist.has(refKey(r)) && !baseline.has(refKey(r)));
}

export function computeStaleBaseline(refs: readonly UppercaseEyebrowRef[], baseline: ReadonlySet<string>): string[] {
  const found = new Set(latinViolations(refs).map(refKey));
  return [...baseline].filter((k) => !found.has(k));
}

function main(): number {
  let refs: UppercaseEyebrowRef[];
  const koJson = loadKoJson(KO_JSON_PATH);
  try {
    refs = scanRepo(SRC_ROOT, koJson);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);
  const violations = latinViolations(refs);
  const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
  const staleBaseline = computeStaleBaseline(refs, baseline);

  console.log(
    `[story #3925] CSS uppercase eyebrow 라틴 노출 스캔 — 정적 추출 ${refs.length}자리 · ` +
      `라틴 검출 ${violations.length}건 · ALLOWLIST ${ALLOWLIST.size}건 · baseline ${baseline.size}건 · ` +
      `신규 ${newViolations.length}건 · stale ${staleBaseline.length}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: ALLOWLIST/baseline에 없는 uppercase eyebrow 라틴 노출 발견:');
    for (const r of newViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  - ${r.file}:${r.line} ${r.key}="${r.value}"`);
    }
    console.error(
      '\n→ ko.json 값을 한국어로 옮길 것 — 정말 §⑤ 허용 액센트(디자인 의도)면 ALLOWLIST에 사유와 함께 등재(PO 승인), ' +
        '이 카드 스코프 밖이면 baseline에 등재(PO 승인, shrink-only).',
    );
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline에 ${staleBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다:`);
    for (const k of staleBaseline.sort()) console.error(`  - ${k}`);
    console.error('\n→ 고쳐졌다면(한국어로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  if (failed) return 1;

  console.log('\nOK: ALLOWLIST/baseline 초과 없음(신규 0건) · stale 0건(죽은 baseline 항목 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
