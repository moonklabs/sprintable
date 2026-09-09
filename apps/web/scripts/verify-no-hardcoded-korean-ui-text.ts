/**
 * story #3741(유나 전수 2026-09-09 08:46Z, doc 08c58b24) — 영어 로케일 화면에 한글이 그대로
 * 서는 하드코딩 문자열의 «신규 증가»만 막는 baseline-freeze 회귀가드. 발견 계기는
 * `chats/page.tsx:19`의 `<EmptyState ... description="왼쪽에서 대화를 선택하세요" />` —
 * `t('title')`처럼 키를 쓰는 옆자리에 한글 문자열을 그대로 박아 둔 자리. 낱말이 틀린
 * 문제가 아니라 «영어 로케일 사용자가 한글을 그대로 본다» 문제다.
 *
 * `apps/web/scripts/verify-no-hardcoded-aria-label.ts`(story #3557)가 이미 있지만 그건
 * `aria-label={\`...\`}` 템플릿 리터럴 한 모양만 본다 — 보이는 본문(JSX 텍스트)·
 * `placeholder`/`title`/`alt`/`aria-*` 속성값을 보는 가드는 이 스토리 前엔 0이었다.
 *
 * ## 기전 — AST(verify-no-handrolled-card.ts와 동형, 새 기전 발명 금지)
 * 정규식 줄 스캔이 아니라 TypeScript AST를 walk한다 — 이유는 «주석은 절대 안 잡혀야
 * 한다»(이 저장소 주석은 한글 천지, 안 걸러지면 전부 오탐)인데, 주석은 AST 노드가
 * 아니라 trivia라 AST walk 자체가 자동으로 걸러준다(정규식처럼 별도로 주석을 벗겨낼
 * 필요가 없다 — 구조적으로 안전).
 *
 * 대상 노드 둘:
 *   ① `JsxText`(엘리먼트 사이 보이는 텍스트) — 한글 유니코드 포함 시 위반.
 *   ② `JsxAttribute`의 문자열 리터럴 값 — 속성 이름이 `placeholder`/`title`/`alt`
 *      이거나 `aria-`로 시작할 때만(스토리 明示 축) 한글 포함 시 위반. `t('key')` 같은
 *      함수 호출값은 StringLiteral이 아니라 이 판정에 애초에 안 걸린다.
 *
 * ## ③ .ts 파일은 「텍스트노드 모드」가 구조적으로 꺼진다
 * `.ts` 파일은 `ts.ScriptKind.TS`로 파싱한다(TSX 아님) — 그러면 `<`/`>`는 제네릭·비교
 * 연산자로만 해석되고 JSX로 절대 안 읽힌다. 유나 첫 판이 `.ts` 파일도 TSX로 파싱해
 * `Record<string, X>`류 제네릭의 `<…>`을 JSX로 오인해 오탐을 냈던 원인 — `.tsx`만
 * `ts.ScriptKind.TSX`로 파싱해 JsxText/JsxAttribute가 실제로 존재하는 파일에서만
 * 그 노드 종류가 나온다(별도 "모드 끄기" 플래그가 아니라 파서 자체가 자연히 그렇게
 * 된다 — 구조적 배제).
 *
 * ## 비목표
 * 기존 230건(baseline)을 전량 i18n 키로 옮기지 않는다 — 이 가드는 오직 «더 늘지
 * 않는다»만 보장한다. 전량 정리는 별건(스토리 明示).
 *
 * ⚠️이 가드가 «못 잡는» 것:
 *   ㉠ 템플릿 리터럴 안의 한글(`` `${x} 왼쪽` ``류) — StringLiteral만 본다, 이유는
 *      템플릿 리터럴은 대개 동적 조합(순수 하드코딩이 아닌 경우가 섞여 오탐 위험이
 *      크다) — 필요해지면 별도 축.
 *   ㉡ `t('key', { x: '한글 기본값' })`처럼 next-intl 폴백 인자 안의 한글 — 함수
 *      호출 인자까지는 안 본다(스토리 明示 축 밖).
 *   ㉢ `placeholder`/`title`/`alt`/`aria-*` 외의 다른 속성(`label` 등)에 박힌 한글 —
 *      스토리가 지정한 4축만 본다, 다른 속성은 후속 판 확장 대상.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// story #3741(스토리 明示 ④) — 내부 도그푸드·약관 화면은 허용목록(사유·카운트). 둘 다
// 일반 최종 사용자가 보는 제품 화면이 아니다: internal-dogfood는 무렌스 내부 전용
// 임시 경로(env flag로 통제)이고, terms/privacy/refund-policy는 법적 고지 문서라
// 한국어 원문이 그대로 서 있어도 되는 성격의 페이지(국문 법무 문서 번역은 별건 판단).
export const EXEMPT_FILES = new Set<string>([
  'app/internal-dogfood/page.tsx',
  'app/terms/page.tsx',
  'app/privacy/page.tsx',
  'app/refund-policy/page.tsx',
]);

const HANGUL_RE = /[가-힣]/;

const TARGET_ATTR_RE = /^(placeholder|title|alt)$/;
function isTargetAttrName(name: string): boolean {
  return TARGET_ATTR_RE.test(name) || name.startsWith('aria-');
}

export interface Violation {
  file: string;
  line: number;
  text: string;
}

export function scanContent(content: string, file: string): Violation[] {
  const isTsx = file.endsWith('.tsx');
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];
  function addIfHangul(node: ts.Node, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0 && HANGUL_RE.test(trimmed)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      violations.push({ file, line, text: trimmed });
    }
  }

  function walk(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      addIfHangul(node, node.getText(sf));
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && isTargetAttrName(node.name.text)) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) {
        addIfHangul(init, init.text);
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return violations;
}

const EXT_RE = /\.tsx?$/;
const TEST_RE = /\.test\.tsx?$/;
// self-assert — 재료가 비정상적으로 적으면(가드가 헛돌고 있으면) 조용한 통과 대신 죽는다.
const MIN_EXPECTED_FILES = 400;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

export function scanRepo(srcRoot: string): Violation[] {
  const files: string[] = [];
  walk(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    if (EXEMPT_FILES.has(rel)) continue;
    const content = readFileSync(abs, 'utf8');
    violations.push(...scanContent(content, rel));
  }
  return violations;
}

/** violation의 안정 키 — 파일+텍스트(줄 번호 제외, 인접 편집에 안 흔들리게 —
 * verify-no-handrolled-card.ts violationKey와 동일 계약). */
export function violationKey(v: Pick<Violation, 'file' | 'text'>): string {
  return `${v.file}::${v.text}`;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'hardcoded-korean-ui-text-baseline.json');

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

// story #3164 PR#3580 관례 — main()과 .test.ts가 같은 판정 심볼을 부르게 export(드리프트
// 방지).
export function computeNewViolations(violations: Violation[], baseline: Set<string>): Violation[] {
  return violations.filter((v) => !baseline.has(violationKey(v)));
}

function main(): number {
  let violations: Violation[];
  try {
    violations = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = computeNewViolations(violations, baseline);
  const grandfathered = violations.filter((v) => baseline.has(violationKey(v)));
  const grandfatheredKeys = new Set(grandfathered.map(violationKey));
  const staleBaseline = [...baseline].filter((k) => !grandfatheredKeys.has(k));

  const fileCount = new Set(violations.map((v) => v.file)).size;
  console.log(
    `[story #3741] 한글 하드코딩 UI 텍스트 스캔 — 검출 ${violations.length}건/${fileCount}파일 · ` +
      `baseline(grandfather) ${baseline.size}건 · 신규 ${newViolations.length}건`,
  );
  if (staleBaseline.length > 0) {
    console.log(`  ⚠️ baseline에 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): ${staleBaseline.length}건`);
  }

  if (newViolations.length > 0) {
    console.error('\nFAIL: baseline에 없는 한글 하드코딩 UI 텍스트 발견(story #3741 회귀):');
    for (const v of newViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  - ${v.file}:${v.line} "${v.text}"`);
    }
    console.error(
      '\n→ 영어 로케일 사용자가 이 한글을 그대로 본다. next-intl i18n 키(messages/ko.json·en.json)로 옮길 것 — ' +
        '내부 도그푸드·약관처럼 정말 정당한 예외라면 EXEMPT_FILES에 사유와 함께 등재(PO 승인).',
    );
    return 1;
  }

  console.log('\nOK: baseline 초과 없음(0건 증가 — «전부 깨끗»이 아니라 «안 늘었다»는 뜻).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const violations = scanRepo(SRC_ROOT);
    const keys = [...new Set(violations.map(violationKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3741(유나 전수 2026-09-09) grandfather baseline — 이 가드 첫 도입 시점 develop의 ' +
          '기존 한글 하드코딩 UI 텍스트(JsxText·placeholder/title/alt/aria-* 속성).',
        '마이그레이션 대상 아님 — 이 게이트는 "더 늘지 않는다"만 보장한다(freeze, 전량 i18n 키화는 후속 별건).',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
