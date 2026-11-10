// story #4885 (UI-2 AC4 · 단축키 표시 정직) — 화면에 «단축키»로 보이는 것은 **눌렀을 때 실제로 받는 곳이 있는 것만**이다.
// 팔레트가 «결재 G I · 일감 G B · 대화 G M · 에이전트 G A · 문서 G S»를, 사이드바가 «일감 B»를 보여 줬지만 그 키를 받는 처리는 코드 어디에도 없었다(눌러도 아무 일 없는 거짓 표시 — PO 11-10).
// 지금 실제로 있는 전역 단축키는 ⌘K(팔레트 열기) 하나다. 새 단축키를 보이려면 **키 처리를 먼저 만들고** 이 표에 한 줄(그 처리가 있는 파일 · 이벤트 키)을 더한다 — 표시하는 쪽(isRealShortcut)은 이 표에 없는 것을 그리지 않고,
// 시험(keyboard-shortcuts.test.ts)은 표의 각 줄이 가리키는 파일에 keydown 처리와 그 키가 실제로 있는지 본다.
// 전역 «G 연타» 이동(G I · G B …)은 새 기능이라 이 장 밖이다(기록만: doc ui2-4885-ac4-status-and-ac3-corrections).
export interface RealShortcut {
  /** 화면에 그려지는 키 조합(예: ['⌘', 'K']) */
  keys: readonly string[];
  /** 그 키를 받는 처리가 있는 파일(src 기준 경로) */
  handler: string;
  /** 그 처리가 비교하는 이벤트 키(소문자) */
  eventKey: string;
}

export const REAL_SHORTCUTS: readonly RealShortcut[] = [
  { keys: ['⌘', 'K'], handler: 'components/nav/app-sidebar.tsx', eventKey: 'k' },
];

export function isRealShortcut(keys: readonly string[] | undefined): boolean {
  if (!keys || keys.length === 0) return false;
  return REAL_SHORTCUTS.some((s) => s.keys.length === keys.length && s.keys.every((k, i) => k === keys[i]));
}
