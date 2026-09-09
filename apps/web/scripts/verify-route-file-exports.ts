/**
 * story #3760(가드·별건 ⑰) — App Router 라우트 파일(page/layout/template/loading/error/
 * not-found/default.tsx)의 named export가 Next.js 화이트리스트 밖이면 `next build`에서만
 * 죽는다(`tsc`·`vitest`는 이 계약을 모른다 — 실물: #4105 21:18Z, `organization/events/
 * page.tsx`에 `publishHistorySenderLabel`을 named export로 두자 build만 빨강,
 * "\"publishHistorySenderLabel\" is not a valid Page export field" — [[feedback_where_you_ran_the_check_is_also_a_value]]).
 *
 * ## 기전 — AST(verify-i18n-keys-exist.ts·verify-no-handrolled-card.ts와 동형, 새 기전
 * 발명 금지) — 정규식 줄 스캔이 아니라 TypeScript AST를 walk한다. `route.ts`는 스캔 밖
 * (HTTP 메서드 named export가 그 파일 형에선 정상 계약이다 — page/layout류와 다른 파일
 * 형).
 *
 * ## 화이트리스트(Next.js App Router route export contract, story 카드 본문 명시)
 * `default`·`metadata`·`generateMetadata`·`viewport`·`generateViewport`·`revalidate`·
 * `dynamic`·`dynamicParams`·`fetchCache`·`runtime`·`preferredRegion`·`maxDuration`·
 * `generateStaticParams`·`experimental_ppr`.
 *
 * ## 완전성(fail-closed) — [[feedback_a_guard_iterating_over_extracted_not_expected_fails_silent]]
 * glob으로 센 파일 수와 실제로 walk한 파일 수가 어긋나면(추출 로직이 일부를 건너뛴 것)
 * 조용한 통과 대신 죽는다 — «추출된 것만 순회»가 아니라 «기대한 수만큼 순회했는가»를
 * 스스로 잰다.
 *
 * ## `export * from '...'` — 못 판정하면 RED
 * 와일드카드 재수출은 그 타깃 모듈을 resolve하지 않는 한 실제로 무엇이 나가는지 정적으로
 * 알 수 없다 — 「모르면 안전하다고 가정」이 아니라 「모르면 위반」으로 fail-closed(이
 * 파일군 전체의 관례와 동형, cross-module 추론은 하지 않는다).
 *
 * ## 못 잡는 것(⚠️)
 *   ㉠ 동적으로 계산된 export 이름(`export const [computed] = ...`)은 TS 문법상 존재하지
 *      않으므로 해당 없음.
 *   ㉡ `.d.ts` 파일은 스캔 대상 glob(`{page,layout,...}.tsx`)에 애초에 안 걸린다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROUTE_FILE_BASENAME_RE = /^(page|layout|template|loading|error|not-found|default)\.tsx$/;

export const APP_ROUTER_EXPORT_WHITELIST: ReadonlySet<string> = new Set([
  'default',
  'metadata',
  'generateMetadata',
  'viewport',
  'generateViewport',
  'revalidate',
  'dynamic',
  'dynamicParams',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'generateStaticParams',
  'experimental_ppr',
]);

export interface ExportViolation {
  file: string;
  line: number;
  name: string;
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.HasModifiers): boolean {
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

// 구조분해 export(`export const { a, b } = obj;`)의 바인딩 이름을 전부 뽑는다 — 라우트
// 파일에 실측 0건이지만(문법상 가능은 하므로) fail-closed로 각 이름을 개별 판정한다.
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  const elements = ts.isObjectBindingPattern(name) ? name.elements : name.elements;
  for (const el of elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
}

export function scanFileContent(content: string, file: string): ExportViolation[] {
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
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일의 export를 못 읽는다 ` +
        `(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4 동형): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const violations: ExportViolation[] = [];
  function report(name: string, node: ts.Node): void {
    if (APP_ROUTER_EXPORT_WHITELIST.has(name)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    violations.push({ file, line, name });
  }

  for (const stmt of sf.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && hasExportModifier(stmt)) {
      const name = hasDefaultModifier(stmt) ? 'default' : (stmt.name?.text ?? '(anonymous)');
      report(name, stmt);
      continue;
    }
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) report(name, stmt);
      }
      continue;
    }
    // `export default <expr>;` — FunctionDeclaration/ClassDeclaration이 아닌 형
    // (화살표 함수·객체 리터럴 등)은 ExportAssignment로 표현된다.
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      report('default', stmt);
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          report(spec.name.text, spec); // spec.name = 외부에서 보이는 이름(재명명 후).
        }
      } else if (!stmt.exportClause) {
        // `export * from '...'` — 타깃을 resolve 안 하므로 뭐가 나가는지 모른다 → fail-closed RED.
        report('* (export * from — 재수출 대상 이름을 정적으로 모름, fail-closed)', stmt);
      }
      continue;
    }
  }

  return violations;
}

function walkRouteFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkRouteFiles(full, out);
    } else if (ROUTE_FILE_BASENAME_RE.test(entry)) {
      out.push(full);
    }
  }
}

export interface ScanRepoResult {
  violations: ExportViolation[];
  fileCount: number;
}

const MIN_EXPECTED_FILES = 50;

export function scanRepo(appRoot: string): ScanRepoResult {
  const files: string[] = [];
  walkRouteFiles(appRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 라우트 파일이 ${files.length}개뿐(appRoot=${appRoot}) — 가드가 헛돌고 있다.`);
  }

  const violations: ExportViolation[] = [];
  let scannedCount = 0;
  for (const abs of files) {
    const rel = path.relative(appRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    violations.push(...scanFileContent(content, rel));
    scannedCount += 1;
  }

  // 완전성(fail-closed) — glob이 찾은 파일 수와 실제로 scanFileContent를 돌린 파일 수가
  // 어긋나면(예: 루프 중간에 예외를 삼키는 변경이 몰래 들어오면) 위반 0건이 「진짜 0건」이
  // 아니라 「덜 본 것」일 수 있다 — 그 둘을 구분 못 하게 두지 않는다.
  if (scannedCount !== files.length) {
    throw new Error(
      `FAIL: glob이 찾은 라우트 파일 ${files.length}개 중 ${scannedCount}개만 실제로 스캔됨 — ` +
        '추출 누락(fail-closed, [[feedback_a_guard_iterating_over_extracted_not_expected_fails_silent]]).',
    );
  }

  return { violations, fileCount: files.length };
}

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app');

function main(): number {
  const { violations, fileCount } = scanRepo(APP_ROOT);

  console.log(
    `[가드] App Router 라우트 파일 named export 스캔 — 파일 ${fileCount}개 · ` +
      `화이트리스트 밖 export ${violations.length}건.`,
  );

  if (violations.length > 0) {
    console.error(`\nFAIL: App Router 화이트리스트 밖 named export ${violations.length}건 — next build에서만 죽는다:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line} "${v.name}"`);
    console.error(
      '\n→ page/layout/template/loading/error/not-found/default.tsx는 Next.js가 정한 export 이름만 ' +
        '허용한다(default·metadata·generateMetadata·viewport·generateViewport·revalidate·dynamic·' +
        'dynamicParams·fetchCache·runtime·preferredRegion·maxDuration·generateStaticParams·' +
        'experimental_ppr). 공유 헬퍼는 라우트 파일 밖(lib/ 등)으로 옮길 것.',
    );
    return 1;
  }

  console.log('\nOK: 모든 라우트 파일의 named export가 App Router 화이트리스트 안에 있다.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
