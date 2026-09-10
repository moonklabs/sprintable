/**
 * story #3770(UI 점검·낱말·역할 원어 키·페드루 PO 確定) — 원시 `role` 값(owner/admin/member류
 * org 역할, implementation/po/qa/design/devops류 participation/trust 역할)을 `t()`(또는
 * 정본 헬퍼 `orgRoleLabel()`/`resolveRoleLabel()`) 없이 JSX 텍스트 자리에 그대로 그리는
 * 클래스를 고정한다. 실 사고: 설정 프로필 「역할」 값이 「관리자」가 아니라 원어 키 `admin`
 * 그대로 라이브에 노출(`my-profile-section.tsx:134` — PO 캡처 눈으로 발견) + 동형 6자리
 * (초대·워크포스·에이전트 관리·채팅 멘션·GNB 조직 스위처 2곳).
 *
 * ## 기전 — AST(verify-no-count-in-title-string.ts·verify-no-legacy-meta-total-consumer.ts와
 * 동형 관례, 새 기전 발명 금지)
 * `apps/web/src` 전수(.tsx)를 walk, JSX 자식(children) 중 `JsxExpression`의 `.expression`이
 * — Identifier이고 이름이 정확히 `role`이거나
 * — PropertyAccessExpression이고 마지막 프로퍼티 이름이 정확히 `role`
 * 인 자리를 찾는다. 이미 `t(...)`/`orgRoleLabel(...)`/`resolveRoleLabel(...)` 등으로
 * 감싼 자리는 `.expression`이 CallExpression이라 이 검사 대상 밖(구조적으로 자동 제외 —
 * 별도 화이트리스트 불요).
 *
 * `<select value={member.role}>` 같은 속성 자리는 JSX **속성**(JsxAttribute)이지 JSX
 * **자식**(JsxChild)이 아니다 — walk가 `JsxElement.children`만 보므로 애초에 대상 밖
 * (ALLOWLIST로 따로 걷어낼 필요 없이 구조가 이미 배제한다, `roles/page.tsx:168`
 * `<option value={member.role}>` 실측 확認).
 *
 * `{member.role ? <span>...` 같은 조건부 렌더의 가드 조건 자체는 top-level 자식이 role
 * PropertyAccessExpression이 아니라 ConditionalExpression이라 마찬가지로 대상 밖(role이
 * 실제로 "그려지는" 안쪽 JsxExpression만 별도로 걸린다).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface RawRoleJsxRef {
  file: string;
  line: number;
}

function isRawRoleExpression(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'role';
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === 'role';
  return false;
}

export function scanJsxFileContent(content: string, file: string): RawRoleJsxRef[] {
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

  const refs: RawRoleJsxRef[] = [];

  function checkChildren(children: ts.NodeArray<ts.JsxChild>): void {
    for (const child of children) {
      if (!ts.isJsxExpression(child) || !child.expression) continue;
      if (isRawRoleExpression(child.expression)) {
        const line = sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1;
        refs.push({ file, line });
      }
    }
  }

  function walk(node: ts.Node): void {
    if (ts.isJsxElement(node)) {
      checkChildren(node.children);
    } else if (ts.isJsxFragment(node)) {
      checkChildren(node.children);
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
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

// ALLOWLIST — story #3770 실 트리 전수 스캔이 PO가 짚은 7자리 외에 6곳을 더 찾았다. 4곳은
// 같은 병(org/trust 역할, 정본 경유로 닫음)이었고, 남은 2곳은 **다른 축**이다:
// `EventDefinition.stage_metadata[stage].role`(워크플로 단계 담당자 라벨 — "Agent"/
// "Human"/"PO"/"Dev"/"Lead"/"Reviewer" 등, `sprintable_get_workflow_guide` 출력 자체가
// 이 낱말들을 원어 그대로 굵게 쓴다·org/trust 역할 정본 셋 어디에도 이 값 집합이 없다).
// org-members.tsx/roles/page.tsx류 "사람의 조직 내 위치"와 다른 개념(워크플로 정의가
// 선언한 "이 단계는 누가"이고, 값 자체가 시스템 전역에서 관례적으로 비-번역 라벨로
// 취급된다 — trustRoleLabelPo="PO"/trustRoleLabelDevops="DevOps"와 같은 결의 축). 새 정본
// 신설은 이 스토리 범위 밖 — 페드루에게 별건 등재 요청, 여기는 이유와 함께 명시 예외.
const ALLOWLIST: ReadonlySet<string> = new Set([
  'app/(authenticated)/organization/events/page.tsx:402',
  'components/loops/loop-create-dialog.tsx:320',
]);

export interface ScanRepoResult {
  refs: RawRoleJsxRef[];
  fileCount: number;
  allowlistHit: Set<string>;
}

const MIN_EXPECTED_TSX_FILES = 300;

export function scanRepo(srcRoot: string): ScanRepoResult {
  const files: string[] = [];
  walkTsxFiles(srcRoot, files);
  if (files.length < MIN_EXPECTED_TSX_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }

  const allRefs: RawRoleJsxRef[] = [];
  let scannedCount = 0;
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    allRefs.push(...scanJsxFileContent(content, rel));
    scannedCount += 1;
  }
  if (scannedCount !== files.length) {
    throw new Error(`FAIL: glob이 찾은 .tsx ${files.length}개 중 ${scannedCount}개만 실제로 스캔됨 — 추출 누락(fail-closed).`);
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

  console.log(
    `[가드] 「원시 role JSX 텍스트」 스캔 — .tsx ${fileCount}개 · 위반 ${refs.length}건(면제 ${allowlistHit.size}/${ALLOWLIST.size}).`,
  );

  const dead = [...ALLOWLIST].filter((k) => !allowlistHit.has(k));
  if (dead.length > 0) {
    console.error('\nFAIL: 죽은 ALLOWLIST 항목(더 이상 안 걸림 — 걷어낼 것):');
    for (const k of dead) console.error(`  ${k}`);
    return 1;
  }

  if (refs.length > 0) {
    console.error('\nFAIL: 원시 role 값이 t() 없이 JSX 텍스트에 그려짐:');
    for (const r of refs) console.error(`  ${r.file}:${r.line}`);
    console.error(
      '\n→ org 역할(owner/admin/member)은 `orgRoleLabel()`(@/lib/org-member-role), ' +
        'participation/trust 역할(implementation 등)은 `resolveRoleLabel()`' +
        '(@/app/(authenticated)/organization/trust/trust-utils)로 감쌀 것(story #3770).',
    );
    return 1;
  }

  console.log('\nOK: 원시 role JSX 텍스트 0건(ALLOWLIST 근거 있는 예외 제외).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
