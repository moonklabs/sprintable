import { LAYER } from '@/components/ds/layers';

/**
 * 4911 — 실행(루프) 화면의 층. 화면 코드는 층 표(`components/ds/layers.ts`)의 이름을 «그대로» 쓰고, `styles/layer-rule.test.ts`가 이 이름이 표와 같은지와 그 층 사이가 눈으로 갈리는지를 지킨다.
 *  - 쪽 바탕(page) = 앱 틀이 한 번 칠함(`PageFrame`은 안 칠함)
 *  - 구획 패널(`RowList` = `Card`) = 내용 칸(panel) — 바탕보다 한 층 위
 *  - 목록 행 얼굴 = 남의 글 줄과 같은 층(rowOthers) — 패널과 ≥ 0.05로 갈림(옛 목록은 +0.027 / 다크 +0.059)
 * 상세 화면의 면은 상세 PR이 이 파일에 더한다.
 */
export const LOOP_ROW_FACE = LAYER.rowOthers;
export const LOOP_PANEL_FACE = LAYER.panel;
/** 거르기 줄은 맨 위에 붙어 따라온다(옛 목록 그대로). 바탕 = 쪽 바탕 층 — `LAYER.page`와 같은 `bg-ds-background`(styles/layer-rule.test.ts의 «쪽 바탕 자리» 표가 이 한 줄을 그대로 지킨다). 틀 안쪽 여백(`PageFrame` p-4 / sm:p-6)만큼 옆으로 번져 줄 뒤로 패널이 비치지 않는다. */
export const LOOP_FILTER_STICKY = 'sticky top-0 z-10 -mx-4 bg-ds-background px-4 py-2 sm:-mx-6 sm:px-6';
/**
 * 상태 칸 = 줄 «앞»의 고정 폭 칸(단계 막대 7칸 96px + 간격 8 + 가장 긴 상태 칩 «결정 중» 약 62px = 약 166px → 11rem). 칸 폭이 줄마다 같아 단계 막대와 제목이 한 세로줄에서 시작한다
 * (옛 배치는 막대 · 칩이 오른쪽 정렬이라 태그 폭만큼 시작점이 흔들렸다 — dev 실측 11-13). 폰(sm 미만)은 폭을 고정하지 않고 칸을 줄 맨 위 한 줄(`max-sm:w-full`)로 내려 왼쪽 정렬한다.
 * 같은 규칙을 «실행 기록» 목록도 쓴다(그쪽 폭 값은 7.5rem — 값은 화면의 상수, 메커니즘은 `ListRow.leadingClassName`).
 */
export const LOOP_STATE_COLUMN = 'sm:w-44 max-sm:w-full';

/**
 * 호버 = 행 얼굴보다 한 단 더 들어간 면(`well`) — 행 얼굴과 같은 색이면 호버가 안 보인다. 그 면 위에서 둘째 줄(계보 · 레시피 · `ink-3`)은 4.5:1 아래(라이트 4.21 · 다크 3.90)라 호버 동안 `ink-2`로 한 단 올린다(둘째 줄 = 행 부품의 `div.font-mono` — 칩은 span이라 안 걸린다).
 * Tailwind가 알아보게 문자열을 통째로 둔다(시험이 `well` 토큰 · 대비를 대조).
 */
export const LOOP_ROW_HOVER = 'hover:bg-ds-surface-highest hover:[&_div.font-mono]:text-ds-ink-2';
