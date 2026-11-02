/**
 * 한글 · 일본어 · 중국어 같은 입력기(IME)로 글자를 «조합하는 중»인 키 입력인가.
 *
 * 조합 중의 엔터는 «글자를 확정하는 키»이고, 조합 중의 에스케이프는 «조합을 취소하는 키»다 — 칸의 제출 · 닫기 동작으로 읽으면
 * 반쯤 쓴 글(예: 폴더 이름 «기획문»)이 그대로 저장되거나 칸이 닫힌다.
 * `isComposing`이 표준이고, `keyCode 229`는 조합 중 키의 옛 표지다(Safari는 `isComposing`이 조합 끝 직후까지 늦게 오는 때가 있다).
 * React 합성 이벤트와 네이티브 이벤트 둘 다 받는다.
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } } | undefined | null): boolean {
  if (!e) return false;
  return e.nativeEvent?.isComposing === true || e.isComposing === true || e.keyCode === 229;
}
