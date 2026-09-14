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
 *
 * story #3875(§⑤ 낱말 드리프트 감사, PO 확定 2026-09-14) — `status`·`activity_type` 축
 * 추가. 실 사고: `story-detail-panel.tsx::formatActivityMessage`(활동 탭)가
 * status_changed 케이스에서 `old_value`/`new_value`(canonical status slug)를 `t()` 없이
 * 그대로 그려 「in-progress → in-review」가 라이브에 노출(선생님 경로: 스토리 패널 활동
 * 탭) + default 케이스가 `activity_type`(내부 enum: created·status_changed 등)을 그대로
 * 노출 — role 축과 같은 병(원시 내부 키가 t() 없이 사용자 표면에 샘).
 *
 * ⚠️`status`·`activity_type`은 `role`보다 훨씬 흔한 식별자 이름이라(HTTP status 코드,
 * React.ReactNode 프롭 이름, 내부 fetch state 등) 순수 이름 매칭만으로는 오탐이 실제로
 * 난다 — story #3875 실측(apps/web/src 전수)으로 17건을 찾아 각각 실 위반(스코프 밖 별
 * 카드 후보)/구조적 오탐/범위 밖(설정 등 §⑤ 미감사 화면)으로 분류해 ALLOWLIST에 근거와
 * 함께 등재했다(아래 ALLOWLIST 참고).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface RawRoleJsxRef {
  file: string;
  line: number;
  /** story #3875 — 어느 축(role/status/activity_type)에 걸렸는지. */
  field: string;
}

const WATCHED_FIELD_NAMES: ReadonlySet<string> = new Set(['role', 'status', 'activity_type']);

function watchedRawFieldName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return WATCHED_FIELD_NAMES.has(expr.text) ? expr.text : null;
  if (ts.isPropertyAccessExpression(expr)) return WATCHED_FIELD_NAMES.has(expr.name.text) ? expr.name.text : null;
  return null;
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
      const field = watchedRawFieldName(child.expression);
      if (field !== null) {
        const line = sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1;
        refs.push({ file, line, field });
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
// 같은 병(org/trust 역할, 정본 경유로 닫음)이었고, 남은 2곳(`EventDefinition.
// stage_metadata[stage].role` 워크플로 단계 담당자 라벨)은 story #3773이 `stageRoleLabel()`
// 정본을 신설해 닫았다 — 이 가드가 스스로 RED로 잡아 알려준 대로 걷는다(죽은 ALLOWLIST
// 항목 자가검출, 유나 확認).
//
// story #3875 — status/activity_type 축 신설 뒤 apps/web/src 전수 실측(17건). 근거 3갈래:
// (a) 구조적 오탐(진짜 원시 status 값이 아님) (b) §⑤ 미감사 화면(설정 등 오늘/일감/우패널/
// 문서/스토리 패널 밖) (c) 실 위반이나 이 카드(story-detail-panel 활동 탭) 스코프 밖 — PO
// 보고 후 후속 카드로 분리 예정, 이 PR 색 변경 0.
const ALLOWLIST: ReadonlySet<string> = new Set([
  // (a) 구조적 오탐 — ListRow의 status는 React.ReactNode 슬롯(호출부가 이미 렌더된 요소를
  // 넘긴다), 원시 status 슬러그가 아니다. 이름만 같을 뿐 이 축이 잡으려는 클래스가 아니다.
  'components/ui/list-row.tsx:44',
  // (a) 구조적 오탐 — HTTP status 코드(숫자, file-viewer 에러 배너)다. 도메인 status enum이
  // 아니라 번역 대상 자체가 아니다(§⑤ 낱말 표는 사용자 도메인 낱말만 다룬다).
  'components/chat/file-viewer.tsx:203',
  // (b) §⑤ 미감사 화면 — 설정/워크플로 실행 이력(기술 로그 표면, 오늘·일감·우패널·문서·
  // 스토리 패널 밖). event_type도 같은 행에서 <code>로 원시 노출 중이라 이 표 전체가
  // 개발자용 기술 로그 성격 — 별도 판단 필요, 이 카드 범위 밖.
  'components/settings/workflow-execution-history-section.tsx:121',
  // (b) §⑤ 미감사 화면 — 설정/워크플로 라인 에디터 버전 이력(기술 관리 화면), 상동.
  'components/settings/workflow-line-editor-section.tsx:272',
  // (c) 실 위반·스코프 밖 — story-detail-panel.tsx의 dependency 행(Blocked by/Blocking/
  // Depends on/Depended by) mono 배지. 같은 행의 영문 ASCII 라벨과 짝인 자리라 story #3876
  // (순 ASCII 라벨 9곳)이 다루는 게 자연스럽다 — 이 카드(#3875, 활동 탭)는 손대지 않는다.
  'components/kanban/story-detail-panel.tsx:2008',
  'components/kanban/story-detail-panel.tsx:2029',
  'components/kanban/story-detail-panel.tsx:2050',
  'components/kanban/story-detail-panel.tsx:2071',
  // (c) 실 위반·스코프 밖 — 목표/스프린트/회고/하루체크인 화면(§⑤ 감사 대상 "일감" 5탭
  // 자체이나, 이 카드의 AC는 스토리 패널 활동 탭 하나로 한정) 각 화면의 story.status 원시
  // 렌더. PO에게 별도 카드 후보로 보고(이 PR 색 변경 0).
  'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx:883',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx:772',
  'app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx:812',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx:553',
  'app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx:773',
  'components/standup/standup-feedback-dialog.tsx:234',
  // (c) 실 위반·스코프 밖 — 가설(hypothesis) 카드의 연결 미리보기 status. 「일감(맥락 패널)」
  // 흡수 축이지 스토리 패널 활동 탭이 아니다 — 별도 카드 후보로 보고.
  'components/epics/hypothesis-declaration-card.tsx:334',
  'components/sprints/hypothesis-declaration-card.tsx:335',
  'components/loops/loop-create-dialog.tsx:524',
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
    `[가드] 「원시 role/status/activity_type JSX 텍스트」 스캔 — .tsx ${fileCount}개 · 위반 ${refs.length}건(면제 ${allowlistHit.size}/${ALLOWLIST.size}).`,
  );

  const dead = [...ALLOWLIST].filter((k) => !allowlistHit.has(k));
  if (dead.length > 0) {
    console.error('\nFAIL: 죽은 ALLOWLIST 항목(더 이상 안 걸림 — 걷어낼 것):');
    for (const k of dead) console.error(`  ${k}`);
    return 1;
  }

  if (refs.length > 0) {
    console.error('\nFAIL: 원시 role/status/activity_type 값이 t() 없이 JSX 텍스트에 그려짐:');
    for (const r of refs) console.error(`  ${r.file}:${r.line} (${r.field})`);
    console.error(
      '\n→ org 역할(owner/admin/member)은 `orgRoleLabel()`(@/lib/org-member-role), ' +
        'participation/trust 역할(implementation 등)은 `resolveRoleLabel()`' +
        '(@/app/(authenticated)/organization/trust/trust-utils)로 감쌀 것(story #3770). ' +
        'status는 `getStatusLabel()` prop 또는 `statusKeyMap`→`t()` 폴백(story #3875, ' +
        'story-detail-panel.tsx의 statusLabel 계산 관례 재사용), activity_type 등 내부 enum은 ' +
        '중립 라벨 1개로 감쌀 것 — 원시 enum 값을 그대로 그리지 말 것.',
    );
    return 1;
  }

  console.log('\nOK: 원시 role/status/activity_type JSX 텍스트 0건(ALLOWLIST 근거 있는 예외 제외).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
