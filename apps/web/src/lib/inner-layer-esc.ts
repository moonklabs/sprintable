/**
 * [SID:4367] 한 Esc = 한 층 — base-ui 창 · 시트(Dialog 원형)의 Esc 닫기 갈래가 안쪽 층이 이미 쓴 Esc를 건너뛰게 한다.
 *
 * 안쪽 층(산출물 댓글 쓰기 칸 · `#` 후보 · 포털 메뉴 등)은 Esc로 자기를 닫고 preventDefault로 «썼다»고 표시한다. useFocusTrap ·
 * 스토리 패널 window Esc · 작업 목록 선택 해제는 그 표시를 보고 건너뛴다. base-ui의 Esc 닫기(useDismiss)는 표시를 안 보고
 * `onOpenChange(false, { reason: 'escape-key' })`를 부르므로, 창 · 시트 뿌리에서 그 갈래를 취소한다(eventDetails.cancel()
 * — DialogStore.setOpen이 취소면 상태를 안 바꾼다). 안쪽 React 핸들러가 base-ui 핸들러보다 먼저 돈다(더 깊은 요소 · 같은 네이티브 이벤트).
 */
export function cancelEscUsedByInnerLayer(
  open: boolean,
  details: { reason?: string; event?: Event; cancel: () => void },
): boolean {
  if (open || details.reason !== 'escape-key' || !details.event?.defaultPrevented) return false;
  details.cancel();
  return true;
}
