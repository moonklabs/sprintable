/**
 * story #4125(라이브 실측, 페드루 PO 2026-09-21 19:59Z) — globals.css 최상위(레이어 밖)
 * 단일-클래스 선택자 규칙 재유입 회귀가드.
 *
 * 근본원인(#4121 AC4 라이브 FAIL로 발견) — `apps/web/src/app/globals.css`는
 * `@import "tailwindcss"`(= `@layer theme, base, components, utilities` 선언)로 시작한다.
 * CSS Cascade Layers 스펙상 **레이어 밖(최상위) 선언은 명시도·소스 순서와 무관하게 모든
 * `@layer` 안 선언을 항상 이긴다.** `.proof-surface { position: relative; ... }`가 최상위에
 * 있어 같은 요소의 `lg:sticky`(Tailwind utilities 레이어)가 무력했다 — sticky 패널이
 * 스크롤을 안 따라갔다(#4121 게이트 상세 액션 열, story #4125 발견분).
 *
 * 이 가드가 재는 것 — globals.css를 파싱해 **어떤 `@layer`/`@media`/`@keyframes` 블록
 * 안에도 없는(depth 0) 단일-클래스 선택자 규칙**(`.foo { ... }`·`.foo::before { ... }` 꼴,
 * 합성/후손 선택자 `.a .b`·속성 선택자 `[data-x]`는 대상 밖 — 아래 ㉠ 참고)을 열거한다.
 * ALLOWLIST(아래, 각 항목 이유 필수) 밖의 새 항목이 하나라도 있으면 FAIL — baseline-freeze
 * 관례(verify-no-new-tint-color-text.ts 등과 동형)가 아니라 **"0 초과 즉시 FAIL"**이다(story
 * #3758 「멤버」/「구성원」 가드와 같은 급 — 이 클래스는 발견되는 순간 그 자리에서 고치는
 * 성질이지 grandfather로 얼릴 채무가 아니다, 페드루 PO 지시).
 *
 * ALLOWLIST(2건, 각각 «유틸리티와 충돌할 수 없는» 이유가 있어 이관 불요) —
 *   - `.dark` — 테마 스위치(:root의 다크 변형). 본문이 전부 `--var: value;`(커스텀 프로퍼티
 *     선언)뿐이고 실제 CSS 프로퍼티(position/border-radius/box-shadow/animation 등)가
 *     하나도 없다(실측 확認) — Tailwind 유틸리티는 이런 커스텀 프로퍼티 이름을 직접 설정하지
 *     않으므로 애초에 경쟁 상대가 없다.
 *   - `.dashboard-shell-root` — 마찬가지로 `--mobile-tab-bar-h`/`--bottom-dock-inset`
 *     커스텀 프로퍼티만 선언(story #3756). 실제 CSS 프로퍼티 0.
 *
 * ㉠이 가드가 «못 잡는» 것(선언, AC4류 원칙) — 후손/속성/의사클래스 복합 선택자(예:
 * `.ProseMirror .scrollbar-visible`·`[data-sonner-toast]`·`.tiptap-content .tiptap ...`)는
 * 대상 밖이다. 이들은 story #2229가 이미 문서화한 대로 **third-party 런타임 주입 스타일
 * (prosemirror-view 등, 항상 unlayered)을 이기기 위해 의도적으로 최상위에 남겨진 것**이거나
 * 리치에디터 전용 스타일로, Tailwind 유틸리티와 같은 요소·같은 속성으로 경쟁할 일이
 * 구조적으로 드물다(단일 클래스와 달리 className prop으로 직접 배선되지 않는 라이브러리
 * 노드뷰 자체 클래스가 대부분). 이 가드의 스코프는 story #4125가 실사고를 실측한 축
 * (단일-클래스 선택자, 컴포넌트가 className으로 직접 붙이는 자리)으로 좁힌다 — 전수
 * 커버리지가 아니라 실사고 클래스 재발 방지.
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
 * 확認하고 이유를 여기 주석에 남긴다(빈 이유 금지, story #4125 PO 지시 — "0 초과 즉시 FAIL"
 * 원칙을 允許 목록으로 우회하는 걸 막는 유일한 장치가 "이유를 적어야 한다"는 사회적 규율). */
export const ALLOWLIST = new Set<string>(['.dark', '.dashboard-shell-root']);

/** globals.css 텍스트에서 depth-0(어떤 @layer/@media/@keyframes 블록 안도 아닌) 단일-클래스
 * 선택자 규칙을 전부 찾는다. 주석은 먼저 걷어내되 줄 번호가 흔들리지 않도록 내용만 지운다
 * (개행은 보존). */
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
      const header = buf.trim();
      const isAtLayer = /^@layer\b/.test(header);
      const isOtherAtRule = /^@/.test(header) && !isAtLayer;
      const topLevel = stack.length === 0;
      if (topLevel && !isAtLayer && !isOtherAtRule) {
        const singleClassMatch = /^\.([A-Za-z][\w-]*)(::?[\w-]+)?$/.exec(header);
        if (singleClassMatch) {
          results.push({ line: lineAt(i), selector: header });
        }
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

  console.log(`[story #4125] globals.css 최상위 단일-클래스 규칙 — 발견 ${found.length}건 · ALLOWLIST ${ALLOWLIST.size}건`);

  if (newRules.length > 0) {
    console.error('\nFAIL: ALLOWLIST 밖의 최상위(레이어 밖) 단일-클래스 규칙 발견(story #4125 회귀):');
    for (const r of newRules) {
      console.error(`  ${r.line}: ${r.selector} { ... }`);
    }
    console.error(
      '\n레이어 밖 규칙은 같은 요소의 Tailwind 유틸리티를 명시도·순서 무관하게 항상 이긴다 ' +
        '(#4121 sticky 실사고가 정확히 이 클래스). `@layer components { ... }`로 감싸거나, ' +
        '정말 커스텀 프로퍼티만 선언해 유틸리티와 경쟁할 수 없다면 이 스크립트의 ALLOWLIST에 ' +
        '이유와 함께 등재한다(PO 승인).',
    );
    return 1;
  }

  console.log('OK: ALLOWLIST 밖의 최상위 단일-클래스 규칙 0건.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
