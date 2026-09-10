/**
 * story #3764(UI 점검 B·E절 잔여+가드) — 유나 定: 「수를 제목 문자열 안에 넣지 않는다」
 * (`「구성원 (13)」`류) — 제목은 고정 문자열, 수는 옆 `CountBadge`로 갈라야 한다(story #3735/
 * #4111이 조직 구성원·권한 화면에서 먼저 닫은 클래스). 이 스토리가 전 저장소로 스윕하며
 * 같은 병이 ②목표 상세(`goals/[id]/page.tsx`)·③글 상세(`content/[draftId]/page.tsx`)·
 * ④캘린더 레인(`unscheduled-lane.tsx`, i18n 값 경유) 세 자리 더 있음을 찾았다 — 이
 * 가드가 그 클래스 전체를 고정한다.
 *
 * ## 두 축(같은 병의 두 다른 생김새)
 * A) **JSX 조립형** — `{t('x')} ({n})`처럼 JSX 안에서 번역 호출과 수가 따로따로 이어붙는
 *    자리. ko.json만 보면 안 나온다(값 자체엔 괄호가 없다 — 조립이 JSX에서 일어난다).
 * B) **i18n 값형** — 메시지 값 자체가 `"날짜 미정 ({count})"`처럼 끝에 수 자리를 괄호로
 *    싣는 자리.
 *
 * ## 기전 — AST(verify-route-file-exports.ts·verify-no-legacy-meta-total-consumer.ts와
 * 동형 관례, 새 기전 발명 금지)
 * A) `apps/web/src` 전수(.tsx)를 walk, JSX 자식 배열에서 4연속
 *    [JsxExpressionContainer(콜 표현식 포함) · JsxText(trim이 "("로 시작) ·
 *    JsxExpressionContainer · JsxText(trim이 ")"로 시작)] 패턴을 찾는다. 음성대조:
 *    `{current} / {limit} ({pct}%)`류(플레이스홀더 뒤에 `%` 등 다른 글자가 끼면 닫는
 *    JsxText가 ")"로 바로 안 시작 — 이 축은 원래도 안 걸린다. `%`가 아니어도 JsxText가
 *    "("로 시작하지 않는 모든 형(예: 콜론·대시로 잇는 자리)은 애초 대상 밖.
 * B) ko.json·en.json 평탄화 값이 정규식 `\(\{[A-Za-z_][A-Za-z0-9_]*\}\)\s*$`(끝이
 *    "(플레이스홀더)"로 정확히 닫히는 자리)에 매치하는 키. `({pct}%)`류(placeholder와
 *    닫는 괄호 사이에 다른 글자가 낌)는 이 정규식 자체가 구조적으로 배제한다 — 이
 *    카드가 든 billing 미터 음성대조 표본과 정확히 같은 이유로 안 걸린다(합성 픽스처로
 *    셀프테스트가 고정).
 *
 * ## ALLOWLIST — 탭 라벨(E절 명시 예외)
 * `board.tasksCountLabel`("태스크 ({count})")·`board.commentsCountLabel`("댓글
 * ({count})") — 그 자리 자체가 «수를 세는 자리»(탭 라벨 관례, doc E절). 영구 예외.
 *
 * (과거 이력 — #4111(story #3735) 소관 일시 예외 3건(`organization/roles/page.tsx`
 * JSX 축·`settings.orgMembersListHeading`·`settings.orgInvitesListHeading` i18n 값
 * 축)은 #4111이 develop에 머지되며 죽은 예외가 됐다(이 가드 자체가 실패시켜 알려준
 * 대로) — 202870e0f 위로 rebase하며 걷었다.)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface JsxTitleCountRef {
  file: string;
  line: number;
}

function isCallLikeExpressionContainer(node: ts.JsxChild): boolean {
  if (!ts.isJsxExpression(node) || !node.expression) return false;
  // t('x') 또는 t('x', {...}) 형 — CallExpression이면 충분(구체 함수명은 안 가린다,
  // 이 화면들이 전부 next-intl useTranslations() 바인딩을 쓰는 관례라 콜 표현식 자체가
  // 이미 좁은 신호다).
  return ts.isCallExpression(node.expression) || ts.isPropertyAccessExpression(node.expression) || ts.isIdentifier(node.expression);
}

export function scanJsxFileContent(content: string, file: string): JsxTitleCountRef[] {
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

  const refs: JsxTitleCountRef[] = [];

  function checkChildren(children: ts.NodeArray<ts.JsxChild>): void {
    for (let i = 0; i + 3 < children.length; i += 1) {
      const a = children[i]!;
      const b = children[i + 1]!;
      const c = children[i + 2]!;
      const d = children[i + 3]!;
      if (
        isCallLikeExpressionContainer(a)
        && ts.isJsxText(b) && b.text.trim().startsWith('(')
        && ts.isJsxExpression(c)
        && ts.isJsxText(d) && d.text.trim().startsWith(')')
      ) {
        const line = sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1;
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

export interface I18nTitleCountRef {
  key: string;
  value: string;
}

// story #3764 실측 정정 — 실 트리에 처음 돌리자 `channelPostsImageConversionFailed`
// ("...{maxBytes} 한도... ({finalBytes})")·`githubLinks.estimated`("추정
// ({confidence})")·`connectConfirmedBadge`("...({date})") 셋이 새로 걸렸다. 이 클래스는
// «제목 옆 수»(«이 목록에 몇 개」)에 국한된 병이지 임의의 끝-괄호-보간 문장 전부가
// 아니다 — 실 코드의 관례상 그 「수」 보간은 항상 리터럴 이름 `count`를 쓴다
// (`tasksCountLabel`·`commentsCountLabel`·`orgMembersListHeading`·
// `orgInvitesListHeading`·`channelPostsCalendarUnscheduledLaneTitle` 전부 `{count}`) —
// 플레이스홀더 이름을 `count`로 좁혀 바이트크기·신뢰도·날짜류(다른 낱말) 오탐을 구조적으로
// 배제한다.
const NUMBER_PLACEHOLDER_PAREN_SUFFIX = /\(\{count\}\)\s*$/;

export function scanI18nMessages(messages: Record<string, unknown>): I18nTitleCountRef[] {
  const refs: I18nTitleCountRef[] = [];
  function flatten(obj: Record<string, unknown>, prefix: string): void {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        if (NUMBER_PLACEHOLDER_PAREN_SUFFIX.test(v)) refs.push({ key, value: v });
      } else if (v && typeof v === 'object') {
        flatten(v as Record<string, unknown>, key);
      }
    }
  }
  flatten(messages, '');
  return refs;
}

// ALLOWLIST — 탭 라벨(E절 명시 예외, 영구).
const I18N_ALLOWLIST: ReadonlySet<string> = new Set([
  'board.tasksCountLabel',
  'board.commentsCountLabel',
]);

// story #3764 rebase(202870e0f, #4111 머지 뒤) — #4111 소관 일시 예외 3건(roles JSX·
// orgMembersListHeading·orgInvitesListHeading)이 죽어(가드가 스스로 잡음) 걷었다.
// JSX 축엔 지금 영구 예외가 없다 — 기전은 남겨 두되(빈 Set) 새 예외가 생기면 여기 등재.
const JSX_ALLOWLIST: ReadonlySet<string> = new Set([]);

export interface ScanRepoResult {
  jsxRefs: JsxTitleCountRef[];
  i18nRefs: I18nTitleCountRef[];
  fileCount: number;
  jsxAllowlistHit: Set<string>;
  i18nAllowlistHit: Set<string>;
}

const MIN_EXPECTED_TSX_FILES = 300;

export function scanRepo(srcRoot: string, koMessages: Record<string, unknown>, enMessages: Record<string, unknown>): ScanRepoResult {
  const files: string[] = [];
  walkTsxFiles(srcRoot, files);
  if (files.length < MIN_EXPECTED_TSX_FILES) {
    throw new Error(`FAIL: 검사 대상 .tsx가 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }

  const allJsxRefs: JsxTitleCountRef[] = [];
  let scannedCount = 0;
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    allJsxRefs.push(...scanJsxFileContent(content, rel));
    scannedCount += 1;
  }
  if (scannedCount !== files.length) {
    throw new Error(`FAIL: glob이 찾은 .tsx ${files.length}개 중 ${scannedCount}개만 실제로 스캔됨 — 추출 누락(fail-closed).`);
  }

  const jsxAllowlistHit = new Set<string>();
  const jsxRefs = allJsxRefs.filter((r) => {
    const key = `${r.file}:${r.line}`;
    if (JSX_ALLOWLIST.has(key)) { jsxAllowlistHit.add(key); return false; }
    return true;
  });

  const koRefs = scanI18nMessages(koMessages);
  const enRefs = scanI18nMessages(enMessages);
  const allI18nRefs = [...koRefs, ...enRefs];
  const seenI18nKeys = new Set(allI18nRefs.map((r) => r.key));

  const i18nAllowlistHit = new Set<string>();
  const i18nRefs = allI18nRefs.filter((r) => {
    if (I18N_ALLOWLIST.has(r.key)) { i18nAllowlistHit.add(r.key); return false; }
    return true;
  });
  // ko/en 어느 쪽이든 걸리면 등재된 것으로 친다(양쪽 다 안 걸리면 dead).
  void seenI18nKeys;

  return { jsxRefs, i18nRefs, fileCount: files.length, jsxAllowlistHit, i18nAllowlistHit };
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');

function main(): number {
  const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8')) as Record<string, unknown>;
  const enMessages = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, unknown>;
  const { jsxRefs, i18nRefs, fileCount, jsxAllowlistHit, i18nAllowlistHit } = scanRepo(SRC_ROOT, koMessages, enMessages);

  console.log(
    `[가드] 「제목 안의 수」 스캔 — .tsx ${fileCount}개 · JSX 조립형 ${jsxRefs.length}건(면제 ${jsxAllowlistHit.size}/${JSX_ALLOWLIST.size}) ` +
      `· i18n 값형 ${i18nRefs.length}건(면제 ${i18nAllowlistHit.size}/${I18N_ALLOWLIST.size}).`,
  );

  const deadJsx = [...JSX_ALLOWLIST].filter((k) => !jsxAllowlistHit.has(k));
  const deadI18n = [...I18N_ALLOWLIST].filter((k) => !i18nAllowlistHit.has(k));
  if (deadJsx.length > 0 || deadI18n.length > 0) {
    console.error('\nFAIL: 죽은 ALLOWLIST 항목(더 이상 안 걸림 — 걷어낼 것):');
    for (const k of deadJsx) console.error(`  [JSX] ${k}`);
    for (const k of deadI18n) console.error(`  [i18n] ${k}`);
    return 1;
  }

  if (jsxRefs.length > 0 || i18nRefs.length > 0) {
    console.error('\nFAIL: 「제목 안의 수」 위반:');
    for (const r of jsxRefs) console.error(`  [JSX] ${r.file}:${r.line}`);
    for (const r of i18nRefs) console.error(`  [i18n] ${r.key} = "${r.value}"`);
    console.error('\n→ 제목은 고정 문자열, 수는 CountBadge로(story #3735/#4111·#3764 처방과 동형).');
    return 1;
  }

  console.log('\nOK: 「제목 안의 수」 0건(ALLOWLIST 근거 있는 예외 제외).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
