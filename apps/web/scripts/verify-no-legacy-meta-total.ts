/**
 * story #3761(API 봉투·낱말 하나·별건 ②) — 목록 응답 meta의 «총계»가 `total`과
 * `totalCount` 두 이름으로 갈려 있었다(story #3744가 `total` 관례로 라우트 2개를 맞췄는데,
 * 유나 낱말 定 정정으로 정본은 `totalCount`(null 허용 = 「총계를 모른다」, goals/tasks/
 * tool-calls가 이미 그 형)). `ApiMeta.total` 필드는 삭제했지만 인덱스 시그니처
 * (`[key: string]: unknown`)가 살아있어 `{ total: N }`류가 타입 에러 없이 다시 들어올 수
 * 있다 — 이 가드가 그 재유입을 막는다.
 *
 * ## 기전 — AST(verify-i18n-keys-exist.ts와 동형 관례, 새 기전 발명 금지)
 * `apps/web/src/app/api/**\/route.ts` 전수를 walk하며 객체 리터럴 프로퍼티 이름이
 * 정확히 `total`인 자리(`PropertyAssignment`·`ShorthandPropertyAssignment` 둘 다)를 찾는다.
 * `totalCount`는 물론 통과 — 이름이 정확히 `total`일 때만 위반(부분 문자열 매치 금지 —
 * `totalPages`·`subtotal` 등 무관 낱말 오탐 방지).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface LegacyTotalRef {
  file: string;
  line: number;
}

export function scanFileContent(content: string, file: string): LegacyTotalRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics === undefined) {
    throw new Error(
      `FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심) — ` +
        '이 가드의 전제(파싱 실패를 스스로 감지할 수 있다는 전제)가 깨졌다(story #2710 동형).',
    );
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일을 못 읽는다 ` +
        `(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4 동형): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const refs: LegacyTotalRef[] = [];
  function walk(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = node.name;
      if (ts.isIdentifier(name) && name.text === 'total') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        refs.push({ file, line });
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

function walkRouteFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkRouteFiles(full, out);
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
}

export interface ScanRepoResult {
  refs: LegacyTotalRef[];
  fileCount: number;
}

const MIN_EXPECTED_FILES = 50;

export function scanRepo(apiRoot: string): ScanRepoResult {
  const files: string[] = [];
  walkRouteFiles(apiRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 route.ts가 ${files.length}개뿐(apiRoot=${apiRoot}) — 가드가 헛돌고 있다.`);
  }

  const refs: LegacyTotalRef[] = [];
  let scannedCount = 0;
  for (const abs of files) {
    const rel = path.relative(apiRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    refs.push(...scanFileContent(content, rel));
    scannedCount += 1;
  }

  // 완전성(fail-closed) — [[feedback_a_guard_iterating_over_extracted_not_expected_fails_silent]]
  if (scannedCount !== files.length) {
    throw new Error(
      `FAIL: glob이 찾은 route.ts ${files.length}개 중 ${scannedCount}개만 실제로 스캔됨 — 추출 누락(fail-closed).`,
    );
  }

  return { refs, fileCount: files.length };
}

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/api');

function main(): number {
  const { refs, fileCount } = scanRepo(API_ROOT);

  console.log(`[가드] API route.ts 메타 total 은퇴 스캔 — 파일 ${fileCount}개 · legacy total 프로퍼티 ${refs.length}건.`);

  if (refs.length > 0) {
    console.error(`\nFAIL: API 라우트 응답 meta에 은퇴한 \`total\` 프로퍼티 ${refs.length}건 발견:`);
    for (const r of refs) console.error(`  ${r.file}:${r.line}`);
    console.error(
      '\n→ 목록 총계는 정본 `totalCount`(number | null, null = "모른다") 하나로 낸다(story #3761). ' +
        '`ApiMeta.total`은 삭제됐다 — `{ totalCount: ... }`로 고칠 것.',
    );
    return 1;
  }

  console.log('\nOK: API 라우트 응답 meta에 은퇴한 `total` 프로퍼티가 없다(정본 totalCount 하나).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
