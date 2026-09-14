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
 * — Identifier이고 이름이 정확히 `WATCHED_FIELD_NAMES`(role·status·activity_type) 중 하나이거나
 * — PropertyAccessExpression이고 마지막 프로퍼티 이름이 그중 하나
 * 인 자리를 찾는다. 이미 `t(...)`/`orgRoleLabel(...)`/`resolveRoleLabel(...)`/
 * `getStatusLabel(...)` 등으로 감싼 자리는 `.expression`이 CallExpression이라 이 검사
 * 대상 밖(구조적으로 자동 제외 — 별도 화이트리스트 불요).
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
 *
 * story #3875 CHANGES(PO 2026-09-14 13:36Z) — ALLOWLIST 키를 `file:line`에서
 * `file::field::<표현식 텍스트>`(+개수, muted-on-tint GRANDFATHER_BASELINE과 동형
 * «정확 일치» 계약)로 교체했다. line 기반 키는 **무관한 PR**이 같은 파일 윗줄에 한 줄만
 * 끼워도 아래 모든 줄이 밀려 위반(새 줄에서 안 걸리던 게 걸림)과 dead(옛 줄에서 안 걸리게
 * 됨)가 동시에 터진다 — 「무관 PR은 exit 0」 계약 위반. 표현식 텍스트(예: `blocker.status`·
 * `story.status`)는 코드가 그 줄 자체를 고치지 않는 한 안정적이라 줄 밀림에 안 흔들린다.
 * 같은 파일 안에 **같은** 표현식이 여러 줄 있으면(예: standup-client.tsx의 `story.status`
 * 2곳) 개수로 합쳐 세되, 정확히 그 개수와 일치해야 한다(늘어도·줄어도 FAIL — PO 승인
 * 없이 조용히 못 움직인다).
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
  /** story #3875 CHANGES — 걸린 표현식의 소스 텍스트(예: `blocker.status`). ALLOWLIST 키
   * 재료(줄 번호 대신 — 무관 PR의 줄 밀림에 안 흔들리게). */
  exprText: string;
}

const WATCHED_FIELD_NAMES: ReadonlySet<string> = new Set(['role', 'status', 'activity_type']);

function watchedRawFieldName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return WATCHED_FIELD_NAMES.has(expr.text) ? expr.text : null;
  if (ts.isPropertyAccessExpression(expr)) return WATCHED_FIELD_NAMES.has(expr.name.text) ? expr.name.text : null;
  return null;
}

/** story #3875 CHANGES — ALLOWLIST/actualCounts 공용 키 조립(파일+축+표현식 텍스트). */
export function allowlistKey(file: string, field: string, exprText: string): string {
  return `${file}::${field}::${exprText}`;
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
        const exprText = child.expression.getText(sf);
        refs.push({ file, line, field, exprText });
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
// 보고 후 후속 카드로 분리(story #3876 dependency 4곳·story #3878 나머지 9곳), 이 PR 색
// 변경 0.
//
// story #3875 CHANGES(PO 2026-09-14 13:36Z) — 키를 `file::field::표현식 텍스트`(+개수)로
// 교체. 값=그 (file,field,exprText) 조합이 실측에서 정확히 몇 번 나와야 하는지(muted-on-tint
// GRANDFATHER_BASELINE과 동형 — 늘어도·줄어도 FAIL).
export const ALLOWLIST: ReadonlyMap<string, number> = new Map([
  // (a) 구조적 오탐 — ListRow의 status는 React.ReactNode 슬롯(호출부가 이미 렌더된 요소를
  // 넘긴다), 원시 status 슬러그가 아니다. 이름만 같을 뿐 이 축이 잡으려는 클래스가 아니다.
  [allowlistKey('components/ui/list-row.tsx', 'status', 'status'), 1],
  // (a) 구조적 오탐 — HTTP status 코드(숫자, file-viewer 에러 배너)다. 도메인 status enum이
  // 아니라 번역 대상 자체가 아니다(§⑤ 낱말 표는 사용자 도메인 낱말만 다룬다).
  [allowlistKey('components/chat/file-viewer.tsx', 'status', 'state.status'), 1],
  // (b) §⑤ 미감사 화면 — 설정/워크플로 실행 이력(기술 로그 표면, 오늘·일감·우패널·문서·
  // 스토리 패널 밖). event_type도 같은 행에서 <code>로 원시 노출 중이라 이 표 전체가
  // 개발자용 기술 로그 성격 — 별도 판단 필요, 이 카드 범위 밖.
  [allowlistKey('components/settings/workflow-execution-history-section.tsx', 'status', 'log.status'), 1],
  // (b) §⑤ 미감사 화면 — 설정/워크플로 라인 에디터 버전 이력(기술 관리 화면), 상동.
  [allowlistKey('components/settings/workflow-line-editor-section.tsx', 'status', 'v.status'), 1],
  // (c) 실 위반·스코프 밖 — story-detail-panel.tsx의 dependency 행(Blocked by/Blocking/
  // Depends on/Depended by) mono 배지. 같은 행의 영문 ASCII 라벨과 짝인 자리라 story #3876
  // (순 ASCII 라벨 9곳)이 다루는 게 자연스럽다 — 이 카드(#3875, 활동 탭)는 손대지 않는다.
  // 변수명이 4곳 다 달라(blocker/blocked/target/source) 표현식 텍스트도 4개 별도 키.
  [allowlistKey('components/kanban/story-detail-panel.tsx', 'status', 'blocker.status'), 1],
  [allowlistKey('components/kanban/story-detail-panel.tsx', 'status', 'blocked.status'), 1],
  [allowlistKey('components/kanban/story-detail-panel.tsx', 'status', 'target.status'), 1],
  [allowlistKey('components/kanban/story-detail-panel.tsx', 'status', 'source.status'), 1],
  // (c) 실 위반·스코프 밖 — 목표/스프린트/회고/하루체크인 화면(§⑤ 감사 대상 "일감" 5탭
  // 자체이나, 이 카드의 AC는 스토리 패널 활동 탭 하나로 한정) 각 화면의 story.status 원시
  // 렌더. PO에게 별도 카드 후보로 보고 済(story #3878). standup-client.tsx는 같은 표현식
  // (story.status)이 2곳(553·773행)이라 한 키에 개수 2로 합쳐 센다.
  [allowlistKey('app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx', 'status', 'story.status'), 1],
  [allowlistKey('app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx', 'status', 'sprint.status'), 1],
  [allowlistKey('app/(authenticated)/[ws]/[proj]/sprints/sprints-client.tsx', 'status', 'selected.status'), 1],
  [allowlistKey('app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx', 'status', 'story.status'), 2],
  [allowlistKey('components/standup/standup-feedback-dialog.tsx', 'status', 'story.status'), 1],
  // (c) 실 위반·스코프 밖 — 가설(hypothesis) 카드의 연결 미리보기 status. 「일감(맥락 패널)」
  // 흡수 축이지 스토리 패널 활동 탭이 아니다 — 별도 카드 후보로 보고 済(story #3878).
  [allowlistKey('components/epics/hypothesis-declaration-card.tsx', 'status', 'value.linkedPreview.status'), 1],
  [allowlistKey('components/sprints/hypothesis-declaration-card.tsx', 'status', 'value.linkedPreview.status'), 1],
  [allowlistKey('components/loops/loop-create-dialog.tsx', 'status', 'linkedHypothesis.status'), 1],
]);

export interface ScanRepoResult {
  /** 스캔이 찾은 원시 refs 전부(ALLOWLIST 필터링 前) — 위반 보고 시 줄 번호 표시용. */
  allRefs: RawRoleJsxRef[];
  fileCount: number;
  /** story #3875 CHANGES — (file,field,exprText) 키별 실측 개수. */
  actualCounts: Map<string, number>;
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

  const actualCounts = new Map<string, number>();
  for (const r of allRefs) {
    const key = allowlistKey(r.file, r.field, r.exprText);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }

  return { allRefs, fileCount: files.length, actualCounts };
}

// story #3875 CHANGES — muted-on-tint GRANDFATHER_BASELINE의 compareToBaseline과 동형
// (새 기전 발명 금지, 기존 패턴 재사용). increased=실측이 baseline보다 많음(신규/증가
// 위반) · stale=baseline이 실측보다 많음(고쳤는데 항목을 안 뺐거나, 이 경우처럼 줄 밀림이
// 아니라 진짜 그 자리가 사라짐).
export interface BaselineDrift { key: string; expected: number; got: number; }
export interface BaselineComparison { increased: BaselineDrift[]; stale: BaselineDrift[]; }

export function compareToBaseline(actual: ReadonlyMap<string, number>, baseline: ReadonlyMap<string, number>): BaselineComparison {
  const increased: BaselineDrift[] = [];
  const stale: BaselineDrift[] = [];
  const allKeys = new Set([...actual.keys(), ...baseline.keys()]);
  for (const key of allKeys) {
    const a = actual.get(key) ?? 0;
    const b = baseline.get(key) ?? 0;
    if (a > b) increased.push({ key, expected: b, got: a });
    else if (a < b) stale.push({ key, expected: b, got: a });
  }
  return { increased, stale };
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function main(): number {
  const { allRefs, fileCount, actualCounts } = scanRepo(SRC_ROOT);
  const { increased, stale } = compareToBaseline(actualCounts, ALLOWLIST);

  console.log(
    `[가드] 「원시 role/status/activity_type JSX 텍스트」 스캔 — .tsx ${fileCount}개 · ` +
      `실측 키 ${actualCounts.size}개(ALLOWLIST ${ALLOWLIST.size}개) · 신규/증가 ${increased.length}건 · stale ${stale.length}건.`,
  );

  if (stale.length > 0) {
    console.error('\nFAIL: stale ALLOWLIST 항목(실측이 더 적음 — 고쳤다면 개수를 맞추거나 항목을 뺄 것):');
    for (const d of stale) console.error(`  ${d.key} (등재 ${d.expected}건 → 실측 ${d.got}건)`);
    return 1;
  }

  if (increased.length > 0) {
    const increasedKeys = new Set(increased.map((d) => d.key));
    const offendingRefs = allRefs.filter((r) => increasedKeys.has(allowlistKey(r.file, r.field, r.exprText)));
    console.error('\nFAIL: 원시 role/status/activity_type 값이 t() 없이 JSX 텍스트에 그려짐(신규/증가):');
    for (const d of increased) console.error(`  ${d.key} (등재 ${d.expected}건 → 실측 ${d.got}건)`);
    console.error('\n실 자리:');
    for (const r of offendingRefs) console.error(`  ${r.file}:${r.line} (${r.field}) — ${r.exprText}`);
    console.error(
      '\n→ org 역할(owner/admin/member)은 `orgRoleLabel()`(@/lib/org-member-role), ' +
        'participation/trust 역할(implementation 등)은 `resolveRoleLabel()`' +
        '(@/app/(authenticated)/organization/trust/trust-utils)로 감쌀 것(story #3770). ' +
        'status는 `getStatusLabel()` prop 또는 `statusKeyMap`→`t()` 폴백(story #3875, ' +
        'story-detail-panel.tsx의 statusLabel 계산 관례 재사용), activity_type 등 내부 enum은 ' +
        '중립 라벨 1개로 감쌀 것 — 원시 enum 값을 그대로 그리지 말 것. 정말 스코프 밖 실 위반이면 ' +
        'ALLOWLIST에 근거와 함께 등재(story #3875 CHANGES 관례 그대로).',
    );
    return 1;
  }

  console.log('\nOK: 원시 role/status/activity_type JSX 텍스트가 ALLOWLIST와 정확히 일치(신규 0·stale 0).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
