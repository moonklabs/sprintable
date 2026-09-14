/**
 * story #3880(§⑤ 낱말 드리프트) AC2(a) — verify-no-raw-ascii-jsx-text.ts(story #3876,
 * JsxText 자식만 대상)의 자매 가드. 실 사고: `<LayerLabel title="Brief"/>`(workcell.tsx)
 * 는 값이 JSX **속성**(JsxAttribute)이라 3876 가드(JsxText만 walk)가 구조적으로 못 봄
 * — role 가드의 `<option value={member.role}>` 제외와 동형 사각(반대 방향: 거기는
 * 속성이라 «제외»가 맞았지만, 여기는 속성 중 «텍스트를 그리는» 프롭은 실제로 화면/
 * 접근성 트리에 보인다).
 *
 * ## 기전 — AST(verify-no-raw-ascii-jsx-text.ts와 동형, 새 기전 발명 금지)
 * `apps/web/src` 전수(.tsx)를 walk, `JsxAttribute`의 이름이 WATCHED_PROP_NAMES에 있고
 * 값이 (a) 직접 `StringLiteral`이거나 (b) `JsxExpression`으로 감쌌지만 그 안이 여전히
 * `StringLiteral`/`NoSubstitutionTemplateLiteral`인 리터럴(표현식 호출이 아님 —
 * `title={t('key')}`는 CallExpression이라 여전히 자동 제외)이며, 공유 술어
 * `isUntranslatedCopy()`에 매칭하면 위반. WATCHED_PROP_NAMES는 story #3880 AC2(a)가
 * 명시한 것만(임의 확장 금지): title·label·placeholder·description·aria-label·alt.
 *
 * story #3880 CHANGES①(PO PR 코멘트, 2026-09-14 16:13Z) — 최초 버전이 직접
 * `StringLiteral`만 봐서 `title={'Brief'}`·`` title={`Brief`} ``(JsxExpression으로
 * 감싼 리터럴)를 놓치는 사각을 PO가 지적 — (b) 분기를 추가해 봉쇄. 동시에 로컬
 * ASCII_WORD_RE를 걷어내고 3876 가드와 같은 공유 술어(scripts/lib/is-untranslated-copy.ts)
 * 로 교체 — 구두점(…·—) 섞인 값도 같은 기준으로 잡는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isUntranslatedCopy } from './lib/is-untranslated-copy';

export interface AsciiJsxAttrRef {
  file: string;
  line: number;
  prop: string;
  text: string;
}

// story #3880 AC2(a) 명시 목록 — 화면(title·label·placeholder·description·alt) 또는
// 접근성 트리(aria-label)에 실제로 텍스트를 그리는 프롭만. 임의 확장 금지(AC 문구 그대로).
const WATCHED_PROP_NAMES: ReadonlySet<string> = new Set(['title', 'label', 'placeholder', 'description', 'aria-label', 'alt']);

// story #3880 CHANGES① — 속성 초기화식에서 순수 리터럴 텍스트를 뽑는다. 직접
// StringLiteral이거나, JsxExpression으로 감쌌지만 그 안이 여전히 StringLiteral/
// NoSubstitutionTemplateLiteral인 경우(`title={'Brief'}`·`` title={`Brief`} ``)만 —
// CallExpression(`t('key')`) 등 다른 표현식은 여기서 걸러진다(undefined 반환).
function extractLiteralText(initializer: ts.JsxAttribute['initializer']): string | undefined {
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    const expr = initializer.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  }
  return undefined;
}

export function scanContent(content: string, file: string): AsciiJsxAttrRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics === undefined) {
    throw new Error(`FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심).`);
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const refs: AsciiJsxAttrRef[] = [];
  function walk(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && WATCHED_PROP_NAMES.has(node.name.getText(sf))) {
      const literalText = extractLiteralText(node.initializer);
      if (literalText !== undefined) {
        const trimmed = literalText.trim();
        if (isUntranslatedCopy(trimmed)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          refs.push({ file, line, prop: node.name.getText(sf), text: trimmed });
        }
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

/** ref의 안정 키 — 파일+프롭+텍스트(줄 번호 제외, story #3875 CHANGES 관례). */
export function refKey(r: Pick<AsciiJsxAttrRef, 'file' | 'prop' | 'text'>): string {
  return `${r.file}::${r.prop}::${r.text}`;
}

// ALLOWLIST — 영구 예외(번역 대상 자체가 아님). story #3880 실측 그라운딩으로 채움.
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

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

export function scanRepo(srcRoot: string): AsciiJsxAttrRef[] {
  const files: string[] = [];
  walkTsxFiles(srcRoot, files);
  if (files.length < MIN_EXPECTED_TSX_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const refs: AsciiJsxAttrRef[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    refs.push(...scanContent(content, rel));
  }
  return refs;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'raw-ascii-jsx-attr-baseline.json');

interface BaselineFile {
  _comment: string[];
  keys: string[];
}

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

export function computeNewViolations(refs: AsciiJsxAttrRef[], allowlist: ReadonlySet<string>, baseline: ReadonlySet<string>): AsciiJsxAttrRef[] {
  return refs.filter((r) => {
    const key = refKey(r);
    return !allowlist.has(key) && !baseline.has(key);
  });
}

export function computeStaleBaseline(refs: AsciiJsxAttrRef[], baseline: ReadonlySet<string>): string[] {
  const foundKeys = new Set(refs.map(refKey));
  return [...baseline].filter((k) => !foundKeys.has(k));
}

function main(): number {
  let refs: AsciiJsxAttrRef[];
  try {
    refs = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
  const staleBaseline = computeStaleBaseline(refs.filter((r) => !ALLOWLIST.has(refKey(r))), baseline);

  const fileCount = new Set(refs.map((r) => r.file)).size;
  console.log(
    `[story #3880 AC2(a)] 텍스트 프롭 순 ASCII 리터럴 스캔(title/label/placeholder/description/aria-label/alt, JsxExpression 감쌈 포함) — ` +
      `검출 ${refs.length}건/${fileCount}파일 · ALLOWLIST ${ALLOWLIST.size}건 · baseline(grandfather) ${baseline.size}건 · ` +
      `신규 ${newViolations.length}건 · stale ${staleBaseline.length}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: ALLOWLIST/baseline에 없는 텍스트 프롭 순 ASCII 리터럴 발견(t() 없이 영문이 ko 로케일에 그대로 노출):');
    for (const r of newViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  - ${r.file}:${r.line} [${r.prop}] "${r.text}"`);
    }
    console.error(
      '\n→ next-intl i18n 키로 옮길 것 — 새 낱말이 필요하면 §⑤ 낱말 표를 먼저 확定(유나) 한 뒤 반영. ' +
        '정말 번역 대상이 아니면(브랜드명·단위 약어 등) ALLOWLIST에 사유와 함께 등재(PO 승인), ' +
        '이 카드 스코프 밖이면 baseline에 등재(PO 승인).',
    );
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline에 ${staleBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다:`);
    for (const k of staleBaseline.sort()) console.error(`  - ${k}`);
    console.error('\n→ 고쳐졌다면(i18n 키로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  if (failed) return 1;

  console.log('\nOK: ALLOWLIST/baseline 초과 없음(신규 0건) · stale 0건(죽은 baseline 항목 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const refs = scanRepo(SRC_ROOT).filter((r) => !ALLOWLIST.has(refKey(r)));
    const keys = [...new Set(refs.map(refKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3880(§⑤ 낱말 드리프트) grandfather baseline — 이 가드 첫 도입 시점(workcell',
        'LayerLabel 4곳 fix 後) develop의 기존 텍스트 프롭 순 ASCII 리터럴 잔존분(이 카드',
        '스코프 밖 화면). 마이그레이션 대상 아님 — "더 늘지 않는다"만 보장(freeze, 전량 정리는 후속 별건).',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
