/**
 * story #2061 회귀가드 — 손수 구현된 모달(`fixed inset-0` 풀뷰포트 오버레이)이 접근성 없이
 * (role="dialog"/aria-modal 없음·포커스 트랩 없음) 새로 들어오는 것을 잡는다.
 *
 * 오늘 13→12곳(#2340에서 2곳 삭제)의 손수 모달을 발견해서 고쳤다 — 대부분은 공용
 * `<Dialog>`(base-ui, 포커스트랩+Esc+반환 내장)로 교체했고, 제스처/render-prop 등으로
 * Dialog 전면교체가 어려운 자리(contextual-panel-layout·docs-client-layout·story-detail-panel·
 * storage-view·notification-bell)는 `useFocusTrap` 훅으로 직접 트랩을 배선했다. 이 가드는
 * 그 규율이 다음에 또 깨지지 않게 지킨다.
 *
 * PO 지적(2026-07-21) 둘 다 반영:
 *  ① role="dialog" 리터럴 존재만 보면 base-ui Popup처럼 role을 컴포넌트 내부에서 붙이는
 *     경우(DialogPrimitive.Popup 등)를 오탐 잡는다 — 그래서 role 부재뿐 아니라 "실제 패턴
 *     (fixed inset-0 + z-index)"인 캐노니컬 프리미티브 태그명도 안전 조건으로 인정한다.
 *  ② 검사 대상 파일이 0이면(cwd/경로 오류 등) 위반 0건과 구분 안 되는 함정을 self-assert로 막는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// `fixed inset-0`(풀뷰포트 오버레이)만 잡는다 — `absolute inset-0`(부모 컨테이너 채움, 썸네일/
// 스켈레톤 등 흔한 무해 패턴)은 의도적으로 제외.
const FIXED_OVERLAY_RE = /\bfixed\s+inset-0\b/;

// 캐노니컬 프리미티브(base-ui Dialog/Sheet) 태그 — role/aria-modal/포커스트랩을 라이브러리가
// 내부에서 이미 처리하므로 우리 소스에 role="dialog" 리터럴이 없어도 안전하다.
const SAFE_PRIMITIVE_TAG_RE =
  /<(DialogPrimitive\.(Backdrop|Popup)|SheetPrimitive\.(Backdrop|Popup)|DialogOverlay|DialogContent|SheetOverlay|SheetContent)\b/;

const ROLE_DIALOG_RE = /role=(["'])(dialog|alertdialog)\1/;
const ARIA_HIDDEN_TRUE_RE = /aria-hidden(=(["']?)true\2|\s*(\/?>|\})|\s+aria-hidden\b)/;

// 판정 태그 자체 근방(전후 몇 줄)만 본다 — 파일 전체가 아니라 그 오버레이 하나의 컨텍스트.
// AST가 아니라 라인 윈도우 휴리스틱이라 완벽하진 않지만(먼 곳의 무관한 aria-hidden을 잘못
// 안전판정할 여지는 이론상 있다), "새 손수 모달이 아무 표식 없이 들어오는" 조악한 회귀를
// 잡는 것이 목적이라 이 정도 근사로 충분하다.
const CONTEXT_WINDOW = 8;

export interface HandrolledModalViolation {
  line: number;
  snippet: string;
}

export function findHandrolledModals(content: string): HandrolledModalViolation[] {
  const lines = content.split('\n');
  const violations: HandrolledModalViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!FIXED_OVERLAY_RE.test(line)) continue;

    const start = Math.max(0, i - CONTEXT_WINDOW);
    const end = Math.min(lines.length, i + CONTEXT_WINDOW + 1);
    const windowText = lines.slice(start, end).join('\n');

    if (SAFE_PRIMITIVE_TAG_RE.test(windowText)) continue; // ① 캐노니컬 프리미티브
    if (ROLE_DIALOG_RE.test(windowText)) continue;        // 손수 구현이지만 role/포커스트랩 배선됨
    if (ARIA_HIDDEN_TRUE_RE.test(windowText)) continue;    // 장식용 backdrop click-catcher

    violations.push({ line: i + 1, snippet: line.trim() });
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

// ② PO 지적 — walk가 조용히 0개를 담아도 위반 0건과 구분이 안 돼 통과해버리는 함정을 막는다
// (#2057에서 실제로 있었던 사고와 동형). 현재 src/**/*.tsx(테스트 제외)가 380개.
const MIN_EXPECTED_FILES = 300;

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
    const content = readFileSync(abs, 'utf8');
    for (const v of findHandrolledModals(content)) {
      allViolations.push({ file: rel, ...v });
    }
  }

  if (allViolations.length > 0) {
    console.error('FAIL: 접근성 없는 손수 구현 모달 발견(story #2061 회귀):');
    for (const v of allViolations) console.error(`  - ${v.file}:${v.line}  ${v.snippet}`);
    console.error(
      '\n`fixed inset-0` 풀뷰포트 오버레이는 공용 `<Dialog>`/`<Sheet>`(@/components/ui)를 쓰거나,' +
        ' 그게 어려우면 `useFocusTrap`(@/hooks/use-focus-trap)으로 role="dialog" aria-modal="true"+포커스' +
        ' 트랩을 직접 배선한다. 순수 장식 backdrop(click-catcher)이면 aria-hidden="true"를 붙인다.',
    );
    process.exit(1);
  }

  console.log(`OK: 손수 구현 모달 회귀 0건 (검사 파일 ${files.length}개)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
