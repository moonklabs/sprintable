/**
 * story #5ead8723(가드·별건 ①) — i18n 키 «실존» 가드. next-intl은 키를 못 찾으면 **키
 * 문자열을 그대로 화면에 그린다**(content/channel-posts/page.tsx:118 주석이 그 함정을
 * 이름으로 적어 둠) — 코드 낱말이 화면에 그대로 서는, 사용자가 보는 거짓의 가장 싼 형.
 * 기존 i18n 가드 셋(no-duplicate-i18n-keys·no-hanja-in-i18n·no-i18n-phrase-collision)은
 * «값»만 보고 «참조가 실존하나»는 안 본다 — 이 가드가 그 축 하나를 새로 채운다.
 *
 * ## 기전 — AST(verify-no-handrolled-card.ts·verify-no-hardcoded-korean-ui-text.ts와 동형,
 * 새 기전 발명 금지)
 * 정규식 줄 스캔이 아니라 TypeScript AST를 walk한다 — 주석은 AST 노드가 아니라 trivia라
 * 자동으로 안 걸린다(별도 주석 제거 로직 불요, 구조적으로 안전 — PO 스캐너의 오탐 2건
 * 「주석 속 t('key')」가 여기선 애초에 발생하지 않는다).
 *
 * ## 스캔 대상
 * `apps/web/src/**\/*.{ts,tsx}`(테스트 제외). 파일마다 한 번 top-down으로 walk하며:
 *
 * ① 네임스페이스 바인딩 — `const X = useTranslations('ns')` · `const X = useTranslations()`
 *   (루트, ns='') · `const X = await getTranslations('ns')` ·
 *   `const X = await getTranslations({ locale, namespace: 'ns' })`. 바인딩은 **마지막으로
 *   본 값이 이긴다**(변수명 재바인딩 — 한 파일 안 여러 컴포넌트가 각자 `const t =
 *   useTranslations(...)`를 갖는 실 패턴, 예: workcell.tsx 8회). top-down 단일 walk가
 *   선언을 그 아래 쓰임보다 항상 먼저 방문하므로(같은 서브트리 안에서 선언이 쓰임의
 *   형제 노드로 먼저 오는 실 코드 형태 — 별도 스코프 추적 없이도 이 순서 하나로 충분하다
 *   실측 확認, `let`/`var` 재대입·별칭 import 0건).
 *
 * ② 호출 — `X('key')` · `X.rich('key')` · `X.raw('key')` · `X.has('key')`(바인딩 var에서만
 *   — Set/Map의 `.has()` 등 무관 호출은 바인딩 필터링으로 자연 배제, 예:
 *   `HIDDEN_SETTINGS_TABS.has('workflow')`). 첫 인자가 **순수 문자열 리터럴**(`ts.
 *   isStringLiteral`)이면 리터럴 키 — `ns.key` 점 경로로 ko/en 실존 대조. 그 외(변수·
 *   템플릿 리터럴·삼항 등 — `ts.isStringLiteral`이 아닌 전부)는 **동적 호출로 카운트만
 *   하고 실패 안 시킨다**(「추출된 것만 순회」의 fails-silent를 「보이는 수」로 바꾼다 —
 *   [[feedback_a_guard_iterating_over_extracted_not_expected_fails_silent]]). 노-서브스티튜션
 *   템플릿(`` `plainKey` ``, 보간 0개라 값이 사실 정적인)도 문법적으로 템플릿이라 동적
 *   버킷 — 스펙 명시("동적 키: 변수·템플릿·삼항") 그대로, 뒤에 보간이 붙어도 재분류가
 *   안 생기게 일관되게 다룬다.
 *
 * ## 못 잡는 것(⚠️)
 *   ㉠ 네임스페이스 자체가 동적(`useTranslations(nsVar)`)인 바인딩은 등록하지 않는다 —
 *      그 var를 통한 이후 호출은 바인딩 미매칭이라 리터럴도 동적도 아닌 채로 조용히
 *      안 잡힌다. 실측 0건(모든 useTranslations/getTranslations 인자가 리터럴이거나
 *      없음) — 생기면 별도 축.
 *   ㉡ 스코프가 실제로 갈리는데(예: 조건부 렌더 두 분기가 다른 네임스페이스를 같은 var
 *      이름으로) 이 파일이 상정하는 「마지막 선언이 이긴다」 단순 모델을 벗어나는 코드는
 *      오분류 가능 — 실측상 이 저장소에 이런 형은 없다(전부 함수 스코프당 정확히 1개
 *      선언).
 *   ㉢ `.d.ts`·타입 전용 파일은 스캔하되 실질 호출이 없어 자연히 기여 0.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type MessageNode = string | { [key: string]: MessageNode };

export interface KeyRef {
  file: string;
  line: number;
  fullKey: string;
}

export interface ScanResult {
  literalRefs: KeyRef[];
  dynamicCount: number;
  totalCallCount: number;
  filesWithBindings: number;
}

const TRANSLATION_METHODS = new Set(['rich', 'raw', 'has']);

function namespaceFromArgs(args: readonly ts.Expression[]): string | null {
  if (args.length === 0) return '';
  const first = args[0];
  if (ts.isStringLiteral(first)) return first.text;
  if (ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties) {
      if (
        ts.isPropertyAssignment(prop)
        && ts.isIdentifier(prop.name)
        && prop.name.text === 'namespace'
        && ts.isStringLiteral(prop.initializer)
      ) {
        return prop.initializer.text;
      }
    }
    return null;
  }
  return null;
}

// 파일 하나를 top-down walk — 바인딩(varName→ns)은 「마지막 선언이 이긴다」(모듈 docstring
// ① 참조). 호출은 그 시점까지의 바인딩 상태로 판정한다.
export function scanFileContent(content: string, file: string): {
  literalRefs: KeyRef[]; dynamicCount: number; totalCallCount: number; hasBindings: boolean;
} {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics === undefined) {
    throw new Error(
      `FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심) — ` +
        '이 가드의 전제(파싱 실패를 스스로 감지할 수 있다는 전제)가 깨졌다(story #2710 동형).',
    );
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일의 i18n 호출을 ` +
        `못 읽는다(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4 동형): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const bindings = new Map<string, string>();
  const literalRefs: KeyRef[] = [];
  let dynamicCount = 0;
  let totalCallCount = 0;

  function registerBindingFromInitializer(varName: string, initRaw: ts.Expression): void {
    const init = ts.isAwaitExpression(initRaw) ? initRaw.expression : initRaw;
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return;
    const callee = init.expression.text;
    if (callee !== 'useTranslations' && callee !== 'getTranslations') return;
    const ns = namespaceFromArgs(init.arguments);
    if (ns === null) return; // ㉠ 동적 네임스페이스 — 바인딩 등록 안 함.
    bindings.set(varName, ns);
  }

  function keyFromCall(node: ts.CallExpression, varName: string): void {
    if (!bindings.has(varName)) return;
    totalCallCount += 1;
    const arg = node.arguments[0];
    if (arg && ts.isStringLiteral(arg)) {
      const ns = bindings.get(varName)!;
      const fullKey = ns ? `${ns}.${arg.text}` : arg.text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      literalRefs.push({ file, line, fullKey });
    } else {
      dynamicCount += 1;
    }
  }

  function walk(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      registerBindingFromInitializer(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        keyFromCall(node, callee.text);
      } else if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && ts.isIdentifier(callee.name)
        && TRANSLATION_METHODS.has(callee.name.text)
      ) {
        keyFromCall(node, callee.expression.text);
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);

  return { literalRefs, dynamicCount, totalCallCount, hasBindings: bindings.size > 0 };
}

const EXT_RE = /\.tsx?$/;
const TEST_RE = /\.test\.tsx?$/;
const MIN_EXPECTED_FILES = 1000;

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

export function scanRepo(srcRoot: string): ScanResult {
  const files: string[] = [];
  walkDir(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const literalRefs: KeyRef[] = [];
  let dynamicCount = 0;
  let totalCallCount = 0;
  let filesWithBindings = 0;
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    const result = scanFileContent(content, rel);
    literalRefs.push(...result.literalRefs);
    dynamicCount += result.dynamicCount;
    totalCallCount += result.totalCallCount;
    if (result.hasBindings) filesWithBindings += 1;
  }
  return { literalRefs, dynamicCount, totalCallCount, filesWithBindings };
}

// story #5ead8723 AC1/AC2 — 점 경로를 메시지 트리에서 내려가 **말단**(string)까지 도달해야
// "존재"다. 도중에 끊기거나(중간 키 부재) 말단이 object로 남으면(경로가 branch에서 멈춤)
// 모두 부재로 판정한다.
export function resolveMessageKey(messages: MessageNode, dottedKey: string): boolean {
  const segments = dottedKey.split('.');
  let cur: MessageNode = messages;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return typeof cur === 'string';
}

// ko↔en 말단 키 집합(전체 경로, dot-joined) — 양방향 차집합 0 판정용.
export function collectLeafKeys(messages: MessageNode, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (typeof messages === 'string') {
    out.add(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(messages)) {
    const next = prefix ? `${prefix}.${k}` : k;
    for (const leaf of collectLeafKeys(v, next)) out.add(leaf);
  }
  return out;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');

function main(): number {
  const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8')) as MessageNode;
  const enMessages = JSON.parse(readFileSync(EN_PATH, 'utf8')) as MessageNode;
  const result = scanRepo(SRC_ROOT);

  const missingKo = result.literalRefs.filter((r) => !resolveMessageKey(koMessages, r.fullKey));
  const missingEn = result.literalRefs.filter((r) => !resolveMessageKey(enMessages, r.fullKey));

  const koLeaves = collectLeafKeys(koMessages);
  const enLeaves = collectLeafKeys(enMessages);
  const koOnly = [...koLeaves].filter((k) => !enLeaves.has(k));
  const enOnly = [...enLeaves].filter((k) => !koLeaves.has(k));

  console.log(
    `[가드] i18n 키 실존 스캔 — 바인딩 있는 파일 ${result.filesWithBindings}개 · ` +
      `리터럴 호출 ${result.literalRefs.length}건 · 동적 호출 ${result.dynamicCount}건 ` +
      `(총 호출 ${result.totalCallCount}건 — 리터럴+동적=총) · ko 말단 ${koLeaves.size} · en 말단 ${enLeaves.size}`,
  );

  let failed = false;

  if (missingKo.length > 0) {
    failed = true;
    console.error(`\nFAIL: ko.json에 없는 키 ${missingKo.length}건:`);
    for (const r of missingKo) console.error(`  ${r.file}:${r.line} "${r.fullKey}"`);
  }
  if (missingEn.length > 0) {
    failed = true;
    console.error(`\nFAIL: en.json에 없는 키 ${missingEn.length}건:`);
    for (const r of missingEn) console.error(`  ${r.file}:${r.line} "${r.fullKey}"`);
  }
  if (koOnly.length > 0) {
    failed = true;
    console.error(`\nFAIL: ko에만 있고 en엔 없는 말단 키 ${koOnly.length}건:`);
    for (const k of koOnly) console.error(`  ${k}`);
  }
  if (enOnly.length > 0) {
    failed = true;
    console.error(`\nFAIL: en에만 있고 ko엔 없는 말단 키 ${enOnly.length}건:`);
    for (const k of enOnly) console.error(`  ${k}`);
  }

  if (failed) {
    console.error(
      '\n→ 코드가 참조하는 i18n 키는 ko/en 둘 다에 값(말단 문자열)으로 있어야 한다. next-intl은 ' +
        '못 찾은 키를 화면에 그대로 그린다 — 사용자가 코드 낱말을 그대로 보는 결함.',
    );
    return 1;
  }

  console.log('\nOK: 코드가 참조하는 리터럴 키 전부 ko/en에 실존·ko↔en 말단 키 집합 동일.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
