/**
 * UI-3(a9d56577) · 4906 — 글자를 쓰는 칸(Input · Textarea · NativeSelect · 채팅 작성창 · 인라인 작성 상자)의 초점 표시 «한 줄 규칙»:
 *   글 칸은 초점이 오면 테두리만 중립 `ink-2`로 한 단계 짙어진다 — 파란 틀(action 테두리 + 고리)은 쓰지 않는다. 파란 `action` 고리는 «누르는 것»(단추 · 탭 · 행 · 체크)이 키보드로 닿을 때만 그린다.
 * 까닭: 브라우저는 글 칸을 마우스로 눌러도 늘 `:focus-visible`로 친다 — CSS로는 «키보드로 들어온 글 칸»과 «눌러서 글 쓰는 중»을 가를 수 없어서, 글 칸의 파란 고리는 쓰는 내내 굵은 파란 틀로 보였다.
 * 키보드로 들어온 사람이 놓치지 않게: 테두리 `ink-2`는 칸 바탕(`surface-sunk`)과 7.6:1(라이트) · 11.3:1(다크)이고 이전 테두리(`line-control`)보다 2.5배 짙다 + 깜박이는 글 커서.
 * 오류(`aria-invalid`)는 이 규칙 밖: `failed` 테두리 + 초점 때 `failed` 고리가 그대로다(빨강은 상태이지 «파란 틀»이 아니다).
 * Tailwind가 클래스를 알아보게 문자열을 통째로 둔다.
 */
export const FIELD_FOCUS = 'focus-visible:border-ds-ink-2 aria-invalid:focus-visible:ring-2 aria-invalid:focus-visible:ring-ds-failed';

/** 안에 글 칸을 품은 «상자»(작성창 · 인라인 작성 상자)용 — 안쪽 칸에 초점이 오면 상자 테두리가 중립으로 짙어진다. */
export const FIELD_FOCUS_WITHIN = 'focus-within:border-ds-ink-2';
