/**
 * story #3761 후속(카디르 QA 지적, PR#4109 검수 中 발견) — verify-no-legacy-meta-total.ts는
 * «내는 쪽»(apps/web/src/app/api/**\/route.ts의 응답 객체 리터럴)만 본다. 소비처(컴포넌트·
 * 훅이 fetch 응답을 읽는 자리)는 그 가드 범위 밖이었고, 실제로 kanban-board.tsx:300에
 * `json.meta?.total`을 읽는 자리가 하나 남아 있었다 — `json`이 인라인 캐스트라 tsc가 못
 * 잡고(ApiMeta 타입 경유가 아니라 as로 직접 형을 지음), 자체 grep 패턴(`meta\?\.total\b`)
 * 으로도 걸렸을 자리인데 카드 AC1(「소비처 meta?.total 참조 0」) 검증을 실제로 돌리지
 * 않아 놓쳤다. 이 스크립트가 그 검증을 코드로 고정한다.
 *
 * ## 기전 — AST(verify-no-legacy-meta-total.ts와 동형 관례, 새 기전 발명 금지)
 * `apps/web/src` 전수(route.ts 포함 — 프로듀서 자리는 애초 `total:` 프로퍼티를 안 쓰므로
 * 이 축엔 안 걸린다)를 walk하며 두 형을 찾는다:
 *   ① `PropertyAccessExpression` — `.name`이 정확히 `total`이고, 그 object(`.expression`)의
 *      "마지막 이름"(Identifier면 그 text, PropertyAccessExpression이면 `.name.text`)이
 *      정확히 `meta`인 자리(`meta.total`·`meta?.total`·`json.meta?.total`·
 *      `res.data.meta.total` 등 깊이 무관 — 마지막 두 마디만 본다).
 *   ② `ElementAccessExpression` — object의 "마지막 이름"이 `meta`이고 인자가 문자열
 *      리터럴 `'total'`/`"total"`인 자리(`meta['total']`).
 * `totalCount`는 이름이 다르므로 애초에 안 걸린다 — 부분 문자열 매치가 아니라 정확한
 * 프로퍼티 이름 비교(`totalPages`·`subtotal`류 무관 낱말과 `meta`가 아닌 다른 객체의
 * `.total`은 오탐하지 않는다).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface LegacyTotalConsumerRef {
  file: string;
  line: number;
}

function lastAccessedName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

export function scanFileContent(content: string, file: string): LegacyTotalConsumerRef[] {
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
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일을 못 읽는다 ` +
        `(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4 동형): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  const refs: LegacyTotalConsumerRef[] = [];
  function push(node: ts.Node): void {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    refs.push({ file, line });
  }
  function walk(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'total' && lastAccessedName(node.expression) === 'meta') {
      push(node);
    } else if (
      ts.isElementAccessExpression(node)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'total'
      && lastAccessedName(node.expression) === 'meta'
    ) {
      push(node);
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

function walkSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

// story #3761 후속(PR#4109 카디르 발견분 fix 中, 미르코 2026-09-10) — 이 가드를 실 트리에
// 처음 돌리자 kanban-board.tsx:300(fix, 이번 PR) 말고 derive-loop-queue.ts:77도 걸렸다.
// 후자는 *다른 축*이다 — `/api/v2/loop-measure-due/queue`(BE FastAPI v2 직결, 이 PR이
// 건드린 Next route.ts 4곳과 무관한 별도 엔드포인트)의 응답을 읽는 자리라 story #3761의
// `ApiMeta.totalCount` 정본화 범위 밖이고(BE 봉투 자체가 다른 축), grep 확認상 그 반환값
// (`LoopQueuePage.total`)을 쓰는 소비처가 0곳이라 이름을 무엇으로 바꿔도 동작은 안
// 바뀌는 죽은 필드다(loop-queue-client.tsx는 `page.items`만 쓴다). 유나가 PR#4109 리뷰에서
// 이미 "죽은 필드·회귀 아님"으로 적기만 표시했다 — 이 PR(#4109/3761) 스코프 밖 파일이라
// 임의로 고치지 않고(스코프 발산 금지) 근거와 함께 면제한다. 재검토 시점 = 이 필드를 실제
// 소비하는 자리가 생기거나 loop-queue 엔드포인트가 손볼 때.
const ALLOWLIST: ReadonlySet<string> = new Set([
  'components/loop-queue/derive-loop-queue.ts:77',
]);

export interface ScanRepoResult {
  refs: LegacyTotalConsumerRef[];
  fileCount: number;
  allowlistHit: Set<string>;
}

const MIN_EXPECTED_FILES = 500;

export function scanRepo(srcRoot: string): ScanRepoResult {
  const files: string[] = [];
  walkSourceFiles(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 .ts/.tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }

  const allRefs: LegacyTotalConsumerRef[] = [];
  let scannedCount = 0;
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    allRefs.push(...scanFileContent(content, rel));
    scannedCount += 1;
  }

  // 완전성(fail-closed) — [[feedback_a_guard_iterating_over_extracted_not_expected_fails_silent]]
  if (scannedCount !== files.length) {
    throw new Error(
      `FAIL: glob이 찾은 .ts/.tsx ${files.length}개 중 ${scannedCount}개만 실제로 스캔됨 — 추출 누락(fail-closed).`,
    );
  }

  const allowlistHit = new Set<string>();
  const refs = allRefs.filter((r) => {
    const key = `${r.file}:${r.line}`;
    if (ALLOWLIST.has(key)) { allowlistHit.add(key); return false; }
    return true;
  });

  return { refs, fileCount: files.length, allowlistHit };
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function main(): number {
  const { refs, fileCount, allowlistHit } = scanRepo(SRC_ROOT);

  console.log(`[가드] 소비처 meta.total 은퇴 스캔 — 파일 ${fileCount}개 · legacy 읽기 ${refs.length}건 · 면제 ${allowlistHit.size}/${ALLOWLIST.size}건.`);

  // 죽은 면제 금지 — phrase-collision 가드(verify-no-i18n-phrase-collision.ts)와 동형
  // 규율: ALLOWLIST에 선언됐는데 실제로 안 걸리는 항목이 있으면(코드가 바뀌어 이미
  // 해소됐거나 줄번호가 밀렸다는 뜻) 그 자체가 실효 없는 면제 — 걷어내라고 실패시킨다.
  if (allowlistHit.size !== ALLOWLIST.size) {
    const dead = [...ALLOWLIST].filter((k) => !allowlistHit.has(k));
    console.error(`\nFAIL: 죽은 ALLOWLIST 항목 ${dead.length}건(더 이상 안 걸림 — 줄번호가 밀렸거나 이미 해소됨, 걷어낼 것):`);
    for (const k of dead) console.error(`  ${k}`);
    return 1;
  }

  if (refs.length > 0) {
    console.error(`\nFAIL: 은퇴한 meta.total 읽기 ${refs.length}건 발견:`);
    for (const r of refs) console.error(`  ${r.file}:${r.line}`);
    console.error(
      '\n→ 목록 총계는 정본 `meta.totalCount`(number | null, null = "모른다") 하나로 읽는다(story #3761). ' +
        '`meta?.total`/`meta.total`/`meta[\'total\']`을 `meta?.totalCount`로 고칠 것.',
    );
    return 1;
  }

  console.log('\nOK: 소비처에 은퇴한 meta.total 읽기가 없다(정본 meta.totalCount 하나, ALLOWLIST 근거 있는 예외 제외).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
