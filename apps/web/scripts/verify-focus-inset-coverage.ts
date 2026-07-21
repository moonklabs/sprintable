/**
 * story #2062 회귀가드 — `overflow-*-auto|scroll` 스크롤 컨테이너가 패딩도 없고
 * `focus-inset`(유나 규격, story #2062)도 없이 새로 들어오는 것을 잡는다.
 *
 * 배경: 패딩 0인 스크롤 컨테이너는 #2057의 포커스 링(outline-offset 2px+width 2px=4px
 * 돌출)이 스크롤 클리핑 박스에 잘린다(CSS 스펙상 overflow-y만 지정해도 overflow-x가
 * auto로 계산돼 좌우도 클리핑된다). 33곳(칸반 포함)을 오늘 고쳤다 — 칸반은 패딩(p-1.5),
 * 나머지 32곳은 `focus-inset` 유틸리티 클래스(globals.css, outline-offset:-2px로 링을
 * 안쪽에 그려 클리핑을 원천 회피)로. 이 가드는 그 규율이 34번째 컨테이너에서 또 깨지지
 * 않게 지킨다.
 *
 * 판정: 같은 className 문자열 안에 overflow 패턴이 있고, 패딩 클래스(p-/px-/py-/pt-/pb-/
 * pl-/pr-)도 `focus-inset`도 없으면 위반. "표식이 아니라 효과"까지 정적으로 검증하긴
 * 어렵다(globals.css의 실제 CSS 규칙이 살아있는지는 별개) — 그건 회귀 시 유닛 테스트가
 * globals.css 자체를 깨뜨리면 별도로 드러난다. 이 가드는 "새 컨테이너가 그 표식을
 * 빠뜨렸는가"만 잡는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const OVERFLOW_RE = /overflow(-[xy])?-(auto|scroll)\b/;
const PADDING_RE = /\b(p|px|py|pt|pb|pl|pr)-(\d|\[)/;
const FOCUS_INSET_RE = /\bfocus-inset\b/;

// 읽기전용 콘텐츠 wrapper — 컨테이너 바로 다음(3줄 이내)이 표/코드블록/수식 렌더면 포커스
// 가능 자식이 없어 클리핑될 링 자체가 없다(실측: chat-bubble/doc-content-renderer의
// markdown 표 렌더러, math-node의 KaTeX, ai-summarize-button의 스트리밍 <pre>). 이걸 넘어
// "포커스 가능 자식이 아예 없다"를 라인 수 기반 부재-휴리스틱으로 일반화하지 않는다 —
// 없음을 증명하는 것은 있음을 증명하는 것보다 오탐(진짜 위반 누락) 위험이 커서, 구조가
// 명확한 이 3개 패턴만 명시적으로 안전 처리한다(PO 판단: "표식이 아니라 효과"까지 완벽히
// 보는 건 과할 수 있으니 판단해서 — 이 선이 그 판단선이다).
const READONLY_CONTENT_LOOKAHEAD_RE = /<(table|pre)\b|\.katex/;
const LOOKAHEAD_LINES = 3;

export interface FocusInsetViolation {
  line: number;
  snippet: string;
}

// className 리터럴/템플릿 리터럴 어느 쪽이든, overflow 패턴이 등장하는 "그 속성 문자열"만
// 본다 — 파일 전체가 아니라 className={`...`} 또는 className="..." 한 덩어리. 직전 JSX 태그
// 이름(tagContext)과 다음 몇 줄(lookahead)도 같이 캡처한다.
function extractClassAttrs(
  content: string,
): { line: number; text: string; tagContext: string; lookahead: string }[] {
  const results: { line: number; text: string; tagContext: string; lookahead: string }[] = [];
  const classAttrRe = /className=(\{`([^`]*)`\}|"([^"]*)")/g;
  let match: RegExpExecArray | null;
  while ((match = classAttrRe.exec(content))) {
    const text = match[2] ?? match[3] ?? '';
    const line = content.slice(0, match.index).split('\n').length;
    const tagContext = content.slice(Math.max(0, match.index - 60), match.index);
    const afterIdx = match.index + match[0].length;
    const lookahead = content
      .slice(afterIdx)
      .split('\n')
      .slice(0, LOOKAHEAD_LINES)
      .join('\n');
    results.push({ line, text, tagContext, lookahead });
  }
  return results;
}

// 자체 base className에 p-4(16px, 4px 돌출분보다 넉넉)를 내장한 캐노니컬 컴포넌트 —
// 호출부 className은 cn()으로 병합될 뿐 그 기본 패딩을 지우지 않으므로(호출부가 명시적
// p-*를 주지 않는 한) 안전하다. dialog.tsx DialogPrimitive.Popup 실측(p-4) 확認.
const SAFE_BASE_COMPONENT_RE = /<DialogContent\b/;

export function findFocusInsetViolations(content: string): FocusInsetViolation[] {
  const violations: FocusInsetViolation[] = [];
  for (const { line, text, tagContext, lookahead } of extractClassAttrs(content)) {
    if (!OVERFLOW_RE.test(text)) continue;
    if (PADDING_RE.test(text)) continue;
    if (FOCUS_INSET_RE.test(text)) continue;
    if (SAFE_BASE_COMPONENT_RE.test(tagContext)) continue;
    // <pre className="overflow-auto ...">처럼 태그 자신이 표/코드블록인 경우(태그명이
    // className보다 앞)와, 컨테이너 바로 다음 줄에 <table>이 오는 경우(태그명이 뒤) 둘 다 본다.
    if (
      READONLY_CONTENT_LOOKAHEAD_RE.test(text) ||
      READONLY_CONTENT_LOOKAHEAD_RE.test(lookahead) ||
      /<(table|pre)\b/.test(tagContext)
    ) continue;
    violations.push({ line, snippet: text.trim().slice(0, 120) });
  }
  return violations;
}

const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;

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

// 검사 대상 0건이면 위반 0건과 구분 안 되는 함정(#2057에서 실제로 겪은 사고) — self-assert.
const MIN_EXPECTED_FILES = 300;

// story #2062 — 의도적으로 미룬 단 하나의 예외. app/dashboard/dashboard-shell.tsx는 앱
// 전체를 감싸는 최상위 셸이라 `focus-inset`을 붙이면 그 안의 모든 후손 :focus-visible이
// inset되는데, 그중 solid `bg-primary` 버튼이 전역에 다수 존재해 각각에 `focus-outset`
// 예외를 달아야 하는 파급 범위를 이 스토리 하나로 판단하기엔 과하다(PO+유나 재검토 필요,
// 아직 미결). 손으로 관리하는 목록은 뒤처진다는 규율을 알면서도 남기는 단 하나의 예외 —
// 목록이 자라면(2번째 항목이 생기면) 그 자체가 "이 방식으로는 못 버틴다"는 신호로 읽는다.
const DEFERRED_FILES = new Set(['app/dashboard/dashboard-shell.tsx']);

function main(): void {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const files: string[] = [];
  walk(srcRoot, files);

  if (files.length < MIN_EXPECTED_FILES) {
    console.error(
      `FAIL: 검사 대상 파일이 ${files.length}개뿐 — 경로/실행 위치가 틀렸을 가능성. 가드가 헛돌고 있다.`,
    );
    console.error(`  srcRoot=${srcRoot} (기대 최소 ${MIN_EXPECTED_FILES}개)`);
    process.exit(1);
  }

  const allViolations: { file: string; line: number; snippet: string }[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    if (DEFERRED_FILES.has(rel)) continue;
    const content = readFileSync(abs, 'utf8');
    for (const v of findFocusInsetViolations(content)) {
      allViolations.push({ file: rel, ...v });
    }
  }

  if (allViolations.length > 0) {
    console.error('FAIL: 패딩도 focus-inset도 없는 스크롤 컨테이너 발견(story #2062 회귀):');
    for (const v of allViolations) console.error(`  - ${v.file}:${v.line}  ${v.snippet}`);
    console.error(
      '\n`overflow-*-auto|scroll` 컨테이너는 패딩(p-*)을 주거나 `focus-inset`(@/app/globals.css,' +
        ' story #2062)을 붙여 포커스 링 클리핑을 막는다. 컨테이너 안에 solid `bg-primary` 버튼이' +
        ' 있으면 그 버튼에 `focus-outset`도 같이 붙인다(inset이면 링=배경 대비 1.00으로 안 보임).',
    );
    process.exit(1);
  }

  console.log(`OK: focus-inset 커버리지 회귀 0건 (검사 파일 ${files.length}개)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
