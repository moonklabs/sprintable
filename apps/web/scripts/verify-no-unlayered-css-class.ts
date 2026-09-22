/**
 * story #4125(라이브 실측, 페드루 PO 2026-09-21 19:59Z) — globals.css 최상위(레이어 밖)
 * 선택자 규칙 재유입 회귀가드. story #4127(2026-09-21 20:23Z 발견분)에서 범위를 "단일-클래스
 * 선택자만"에서 "클래스 또는 속성 선택자를 품은 depth-0 선택자 전부"(후손/복합/속성 선택자
 * 포함)로 넓혔다.
 *
 * 근본원인(#4121 AC4 라이브 FAIL로 발견) — `apps/web/src/app/globals.css`는
 * `@import "tailwindcss"`(= `@layer theme, base, components, utilities` 선언)로 시작한다.
 * CSS Cascade Layers 스펙상 **레이어 밖(최상위) 선언은 명시도·소스 순서와 무관하게 모든
 * `@layer` 안 선언을 항상 이긴다.** `.proof-surface { position: relative; ... }`가 최상위에
 * 있어 같은 요소의 `lg:sticky`(Tailwind utilities 레이어)가 무력했다 — sticky 패널이
 * 스크롤을 안 따라갔다(#4121 게이트 상세 액션 열, story #4125 발견분).
 *
 * 이 가드가 재는 것 — globals.css를 파싱해 **어떤 `@layer`/`@media`/`@keyframes` 블록
 * 안에도 없는(depth 0) 선택자 규칙 중 클래스(`.foo`) 또는 속성(`[data-x]`) 선택자를 하나라도
 * 품은 것**을 전부 열거한다(단일/후손/복합/콤마-병기 전부 대상 — `:root`처럼 클래스·속성을
 * 전혀 안 품은 선택자만 구조적으로 스코프 밖). ALLOWLIST(아래, 각 항목 이유 필수) 밖의 새
 * 항목이 하나라도 있으면 FAIL — baseline-freeze 관례(verify-no-new-tint-color-text.ts 등과
 * 동형)가 아니라 **"0 초과 즉시 FAIL"**이다(story #3758 「멤버」/「구성원」 가드와 같은 급 —
 * 이 클래스는 발견되는 순간 그 자리에서 고치는 성질이지 grandfather로 얼릴 채무가 아니다,
 * 페드루 PO 지시).
 *
 * 선택자 문자열은 소스의 줄바꿈/들여쓰기를 `replace(/\s+/g, ' ')`로 정규화한 뒤 비교한다 —
 * 콤마-병기 선택자(`.a,\n.b { ... }`)가 파일 안에서 물리적으로 두 줄에 걸쳐 있어도 원문
 * 그대로 매칭하면 포매팅이 바뀔 때마다 ALLOWLIST가 깨지기 때문(story #4127 실측 —
 * `.tiptap-content .tiptap ul,`/`.tiptap-content .tiptap ol`이 정확히 이 꼴).
 *
 * ALLOWLIST(46종 고유 selector — 스캔은 47건 원문 규칙을 찾지만 `.ProseMirror .scrollbar-visible
 * pre`가 별개 규칙 2개로 같은 선택자 문자열이라 Set에서는 1종으로 합쳐진다, 그룹별 이유) —
 *
 *   [테마 스위치 — 유틸리티가 경쟁할 실제 CSS 프로퍼티가 없음, 1건]
 *   - `.dark` — :root의 다크 변형. 본문이 전부 `--var: value;`뿐, 실제 CSS 프로퍼티 0.
 *
 * story #4131 — `--shell-chrome-h`(`.dashboard-shell-root`/`[data-topbar-hidden]`/미디어
 * 쿼리 3벌)는 ALLOWLIST에 안 넣는다. 이유 있는 «기존» 비레이어만 여기 남기는 것이 정본
 * (페드루 PO, 2026-09-22) — 새 규칙은 커스텀 프로퍼티만이라 유틸리티와 다툴 속성이 없어도
 * `@layer components`로 이관한다(결과는 같음·D1 sidebar 예방 이관과 같은 길). globals.css
 * 본문 참고. story #4006(critical, 5pt) AC8 PO CHANGES-1 ③ — `.dashboard-shell-root`
 * 자신도 `.v3-shell-root`와 나란히 같은 길로 @layer components 이관(그 전까지 여기
 * ALLOWLIST에 있던 항목 제거).
 *   [story #2229 기존 문서화 — third-party(prosemirror-view) unlayered 런타임 주입 스타일을
 *    이기기 위해 의도적으로 레이어 밖에 남겨진 것, 7건 — 이관 절대 금지, #2214 재발 유발]
 *   - `.ProseMirror .scrollbar-visible`
 *   - `.ProseMirror .scrollbar-visible pre` (×2 — 원본 규칙 + scrollbar 스타일 규칙, 같은
 *     선택자로 별개 2개 rule)
 *   - `.ProseMirror .scrollbar-visible pre::-webkit-scrollbar`
 *   - `.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-track`
 *   - `.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-thumb`
 *   - `.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-thumb:hover`
 *
 *   [Tiptap/ProseMirror 자체 렌더 DOM — 에디터 라이브러리가 자기 스키마로 직접 렌더하는
 *    노드(문서 본문 p/h1/table/taskList 등)라 React 컴포넌트가 className prop을 못 건다 —
 *    유틸리티가 원리적으로 경쟁 불가, 37건 — story #4127 AC1 그룹 A]
 *   - `.tiptap-content .tiptap` 및 그 자손 선택자 전부(p/h1/h2/h3/code/pre/pre code/
 *     blockquote/ul,ol/ul/ol/img/table/td,th/th/hr/is-editor-empty/ProseMirror-selectednode/
 *     a/a[href^="entity:"]/div[data-callout]/taskList 계열 5개, 아래 정확한 문자열)
 *   - `[data-type="columnsBlock"]`/`[data-type="columnBlock"]`/`:focus-within`/
 *     `[data-cols="2"/"3"]` 계열(컬럼 블록 nodeView)
 *   - `[data-type="toggleBlock"]`/`[data-type="toggleContent"]`/`[data-type="toggleSummary"]`
 *     계열(토글 블록 nodeView)
 *
 *   [서드파티 라이브러리(sonner) 내부 DOM — className prop 미경유, 2건 — story #4127 AC1
 *    그룹 C. `[data-sonner-toast]`는 이미 `!important`로 sonner 기본 스타일을 이기도록
 *    의도된 것이라 @layer 이관 시 오히려 의미가 바뀐다(레이어 간 !important 우선순위는
 *    일반 규칙과 반대 방향 — layer 안 !important끼리는 먼저 선언된 layer가 이긴다)]
 *   - `[data-sonner-toast]`
 *   - `[data-sonner-toast] [data-icon]`
 *
 * 이관 완료(참고, ALLOWLIST에는 없음) — `[data-sidebar="menu-button"][data-popup-open]`은
 * story #4127에서 `@layer components`로 이관했다(sidebar.tsx의 실제 React 컴포넌트 대상이라
 * 유틸리티와 진짜 경쟁 가능 — 지금은 같은 CSS 변수라 시각 차이가 없었지만 예방적 이관).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');

export interface UnlayeredClassRule {
  line: number;
  selector: string;
}

/** ALLOWLIST — 항목을 추가하려면 반드시 "왜 유틸리티와 경쟁할 수 없는지"를 실측(grep)으로
 * 확認하고 이유를 위 헤더 주석에 남긴다(빈 이유 금지, story #4125 PO 지시 — "0 초과 즉시 FAIL"
 * 원칙을 允許 목록으로 우회하는 걸 막는 유일한 장치가 "이유를 적어야 한다"는 사회적 규율).
 * 선택자 문자열은 소스 공백을 단일 스페이스로 정규화한 형태(아래 findUnlayeredClassRules 참고). */
export const ALLOWLIST = new Set<string>([
  '.dark',
  '.ProseMirror .scrollbar-visible',
  '.ProseMirror .scrollbar-visible pre',
  '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar',
  '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-track',
  '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-thumb',
  '.ProseMirror .scrollbar-visible pre::-webkit-scrollbar-thumb:hover',
  '.tiptap-content .tiptap',
  '.tiptap-content .tiptap p',
  '.tiptap-content .tiptap h1',
  '.tiptap-content .tiptap h2',
  '.tiptap-content .tiptap h3',
  '.tiptap-content .tiptap code',
  '.tiptap-content .tiptap pre',
  '.tiptap-content .tiptap pre code',
  '.tiptap-content .tiptap blockquote',
  '.tiptap-content .tiptap ul, .tiptap-content .tiptap ol',
  '.tiptap-content .tiptap ul',
  '.tiptap-content .tiptap ol',
  '.tiptap-content .tiptap img',
  '.tiptap-content .tiptap table',
  '.tiptap-content .tiptap td, .tiptap-content .tiptap th',
  '.tiptap-content .tiptap th',
  '.tiptap-content .tiptap hr',
  '.tiptap-content .tiptap .is-editor-empty.is-empty::before',
  '.tiptap-content .tiptap .ProseMirror-selectednode',
  '.tiptap-content .tiptap a',
  '.tiptap-content .tiptap a[href^="entity:"]',
  '.tiptap-content .tiptap div[data-callout]',
  '.tiptap-content .tiptap ul[data-type="taskList"]',
  '.tiptap-content .tiptap ul[data-type="taskList"] li[data-type="taskItem"]',
  '.tiptap-content .tiptap ul[data-type="taskList"] li[data-type="taskItem"] > label',
  '.tiptap-content .tiptap ul[data-type="taskList"] li[data-type="taskItem"] > label input[type="checkbox"]',
  '.tiptap-content .tiptap ul[data-type="taskList"] li[data-type="taskItem"] > div',
  '.tiptap-content .tiptap ul[data-type="taskList"] li[data-type="taskItem"][data-checked="true"] > div p',
  '[data-type="columnsBlock"] > [data-type="columnBlock"], .tiptap [data-type="columnsBlock"] > .contents > [data-type="columnBlock"]',
  '[data-type="columnBlock"]',
  '[data-type="columnBlock"]:focus-within',
  '[data-type="columnsBlock"]',
  '[data-type="columnsBlock"][data-cols="2"]',
  '[data-type="columnsBlock"][data-cols="3"]',
  '[data-type="toggleBlock"][data-open="false"] > [data-type="toggleContent"], .tiptap [data-type="toggleBlock"][data-open="false"] > [data-type="toggleContent"]',
  '[data-type="toggleContent"], .tiptap [data-type="toggleContent"]',
  '[data-type="toggleSummary"], .tiptap [data-type="toggleSummary"]',
  '[data-sonner-toast]',
  '[data-sonner-toast] [data-icon]',
]);

/** header(정규화된 selector 문자열)가 클래스(`.foo`) 또는 속성(`[data-x]`) 선택자를 하나라도
 * 품었는지 — 단일/후손/복합/콤마-병기 전부 이 정규식 하나로 잡힌다(부분 매치라 위치 무관).
 * `:root`/`::selection`처럼 클래스·속성이 전혀 없는 순수 pseudo 선택자만 구조적으로 제외된다. */
function containsClassOrAttributeSelector(header: string): boolean {
  return /\.[A-Za-z][\w-]*|\[[\w-]/.test(header);
}

/** globals.css 텍스트에서 depth-0(어떤 @layer/@media/@keyframes 블록 안도 아닌) 선택자 규칙 중
 * 클래스 또는 속성 선택자를 품은 것을 전부 찾는다. 주석은 먼저 걷어내되 줄 번호가 흔들리지
 * 않도록 내용만 지운다(개행은 보존). selector는 공백 정규화(줄바꿈/들여쓰기 → 단일 스페이스)
 * 후 저장 — 콤마-병기 선택자가 물리적으로 여러 줄에 걸쳐 있어도 ALLOWLIST 매칭이 포매팅에
 * 흔들리지 않게 한다. */
export function findUnlayeredClassRules(css: string): UnlayeredClassRule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));

  const stack: { isAtLayer: boolean; isOtherAtRule: boolean }[] = [];
  const results: UnlayeredClassRule[] = [];
  let buf = '';
  const n = noComments.length;

  const lineAt = (pos: number): number => noComments.slice(0, pos).split('\n').length;

  for (let i = 0; i < n; i += 1) {
    const ch = noComments[i];
    if (ch === '{') {
      const rawHeader = buf.trim();
      const header = rawHeader.replace(/\s+/g, ' ');
      const isAtLayer = /^@layer\b/.test(header);
      const isOtherAtRule = /^@/.test(header) && !isAtLayer;
      const topLevel = stack.length === 0;
      if (topLevel && !isAtLayer && !isOtherAtRule && header && containsClassOrAttributeSelector(header)) {
        results.push({ line: lineAt(i), selector: header });
      }
      stack.push({ isAtLayer, isOtherAtRule });
      buf = '';
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else if (ch === ';' && stack.length === 0) {
      buf = ''; // 최상위 statement(@import ...;)는 버퍼 리셋.
    } else {
      buf += ch;
    }
  }
  return results;
}

function main(): number {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const found = findUnlayeredClassRules(css);
  const newRules = found.filter((r) => !ALLOWLIST.has(r.selector));

  console.log(`[story #4125/#4127] globals.css 최상위 클래스/속성 선택자 규칙 — 발견 ${found.length}건 · ALLOWLIST ${ALLOWLIST.size}건`);

  if (newRules.length > 0) {
    console.error('\nFAIL: ALLOWLIST 밖의 최상위(레이어 밖) 클래스/속성 선택자 규칙 발견(story #4125/#4127 회귀):');
    for (const r of newRules) {
      console.error(`  ${r.line}: ${r.selector} { ... }`);
    }
    console.error(
      '\n레이어 밖 규칙은 같은 요소의 Tailwind 유틸리티를 명시도·순서 무관하게 항상 이긴다 ' +
        '(#4121 sticky 실사고가 정확히 이 클래스). `@layer components { ... }`로 감싸거나, ' +
        '정말 유틸리티와 경쟁할 수 없다면(에디터/서드파티 내부 DOM·커스텀 프로퍼티만 선언 등) ' +
        '이 스크립트의 ALLOWLIST에 이유와 함께 등재한다(PO 승인).',
    );
    return 1;
  }

  console.log('OK: ALLOWLIST 밖의 최상위 클래스/속성 선택자 규칙 0건.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
