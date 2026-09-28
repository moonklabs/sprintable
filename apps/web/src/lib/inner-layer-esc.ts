/**
 * [SID:4367] 한 Esc = 한 층 — base-ui 창 · 시트(Dialog 원형)의 Esc 닫기 갈래가 안쪽 층이 이미 쓴 Esc를 건너뛰게 한다.
 *
 * 안쪽 층(산출물 댓글 쓰기 칸 · `#` 후보 · 포털 메뉴 등)은 Esc로 자기를 닫고 preventDefault로 «썼다»고 표시한다. useFocusTrap ·
 * 스토리 패널 window Esc · 작업 목록 선택 해제는 그 표시를 보고 건너뛴다. base-ui의 Esc 닫기(useDismiss)는 표시를 안 보고
 * `onOpenChange(false, { reason: 'escape-key' })`를 부르므로, 창 · 시트 뿌리에서 그 갈래를 취소한다(eventDetails.cancel()
 * — DialogStore.setOpen이 취소면 상태를 안 바꾼다). 안쪽 React 핸들러가 base-ui 핸들러보다 먼저 돈다(더 깊은 요소 · 같은 네이티브 이벤트).
 *
 * ⚠️ 표시(Esc에 preventDefault)는 **그 Esc로 자기 층을 닫을 때만** 한다(까디르 · PR 4749 기록). 닫지 않으면서 표시하면 그 요소를 품은
 * 창 · 시트 · 서랍 · 패널이 Esc로 영영 안 닫힌다(갇힘). 가드: lib/esc-mark-closes-own-layer.guard.test.ts.
 *
 * [SID:4369] 유나 규칙 — 층이 Esc로 닫히기 전에 초점이 **여러 줄 칸**(textarea · contenteditable)에 있으면:
 *   ① 한글 조합 중 Esc = 조합만 취소(층은 아무것도 안 함)
 *   ② 글 있음 → 첫 Esc = 칸에서만 빠져나옴(글 유지 · 초점 = 층 뿌리 tabIndex=-1) · 둘째 Esc = 층 닫힘
 *   ③ 글 없음 → 층이 한 번에 닫힘
 * **한 줄 칸**(input text/search/url …)은 «Esc = 취소/지움» 관례 그대로 — 이 도우미는 손대지 않는다.
 * 층마다 한 곳에서 부른다: 스토리 패널 window Esc · useFocusTrap · 작업 목록 선택 해제 · 지원 위젯 · 창/시트 원형(아래 guardEscClose).
 */

/** ① 한글(IME) 조합 중인 Esc — 조합만 취소되게 층은 아무것도 안 한다. keyCode 229 = 조합 중 키(Safari는 isComposing이 늦게 옴). */
export function isComposingEsc(e: { isComposing?: boolean; keyCode?: number } | undefined | null): boolean {
  return !!e && (e.isComposing === true || e.keyCode === 229);
}

/** 글이 있는 여러 줄 칸이면 그 칸 — textarea · contenteditable만(한 줄 칸은 관례 그대로라 null). */
export function multilineFieldWithText(el: EventTarget | Element | null | undefined): HTMLElement | null {
  if (!el || typeof (el as Element).nodeType !== 'number') return null;
  if (el instanceof HTMLTextAreaElement) return el.value.trim() ? el : null;
  if (el instanceof HTMLElement && el.isContentEditable) {
    const host = (el.closest('[contenteditable="true"], [contenteditable=""]') as HTMLElement | null) ?? el;
    return (host.textContent ?? '').trim() ? host : null;
  }
  return null;
}

/** 칸에서 빠져나옴 — 층 뿌리가 초점을 받을 수 있으면(tabindex) 거기로, 아니면 칸만 blur. 글은 그대로. */
function leaveField(field: HTMLElement, layerRoot: HTMLElement | null): void {
  if (layerRoot && layerRoot.hasAttribute('tabindex')) layerRoot.focus();
  else field.blur();
}

/**
 * 층 Esc 앞단(①②). 참이면 층은 이 Esc로 닫지 않는다.
 * - 조합 중이면 참(표시 안 함 — IME가 조합을 취소).
 * - 초점이 layerRoot 안(없으면 어디든) 글 있는 여러 줄 칸이면: 칸에서만 빠져나오고 preventDefault(이 Esc를 «칸 층»이 썼다 — 바깥 층 건너뜀) → 참.
 */
export function leaveMultilineFieldOnEsc(e: KeyboardEvent, layerRoot: HTMLElement | null): boolean {
  if (e.key !== 'Escape') return false;
  if (isComposingEsc(e)) return true;
  const field = multilineFieldWithText(e.target) ?? multilineFieldWithText(typeof document === 'undefined' ? null : document.activeElement);
  if (!field || (layerRoot && !layerRoot.contains(field))) return false;
  e.preventDefault();
  leaveField(field, layerRoot);
  return true;
}

export function cancelEscUsedByInnerLayer(
  open: boolean,
  details: { reason?: string; event?: Event; cancel: () => void },
): boolean {
  if (open || details.reason !== 'escape-key' || !details.event?.defaultPrevented) return false;
  details.cancel();
  return true;
}

/**
 * 창 · 시트 원형(ui/dialog.tsx · ui/sheet.tsx) 뿌리의 onOpenChange 앞단 — Esc 닫기 갈래만 본다.
 * 안쪽 층이 쓴 Esc(4367) · 조합 중 Esc(①) · 글 있는 여러 줄 칸의 첫 Esc(②)면 닫기를 취소한다. ②는 칸에서 팝업 뿌리로 초점을 옮긴다.
 */
export function guardEscClose(
  open: boolean,
  details: { reason?: string; event?: Event; cancel: () => void },
): boolean {
  if (open || details.reason !== 'escape-key') return false;
  if (cancelEscUsedByInnerLayer(open, details)) return true;
  const ev = details.event as KeyboardEvent | undefined;
  if (isComposingEsc(ev)) { details.cancel(); return true; }
  const field = multilineFieldWithText(ev?.target) ?? multilineFieldWithText(typeof document === 'undefined' ? null : document.activeElement);
  if (!field) return false;
  details.cancel();
  ev?.preventDefault();
  leaveField(field, field.closest('[data-slot="dialog-content"], [data-slot="sheet-content"], [role="dialog"]') as HTMLElement | null);
  return true;
}
