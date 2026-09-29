'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { AnchoredPopover, isOutsidePress } from '@/components/shared/anchored-popover';
import { leaveMultilineFieldOnEsc } from '@/lib/inner-layer-esc';
import { useFieldDraft } from '@/hooks/use-field-draft';

interface CommentComposePopoverProps {
  /** 성공이면 true — 그때만 초안을 지운다. */
  onSubmit: (body: string) => Promise<boolean>;
  /** 팝오버를 닫는다(글은 버리지 않음 — 초안으로 남음). */
  onCancel: () => void;
  /** story #4370 — 초안 키(산출물 id). 핀 자리는 닫힐 때 버려지므로 산출물 단위로 둔다. */
  draftTargetId: string | null;
  style?: React.CSSProperties;
  className?: string;
  /**
   * story #4373 — 붙을 핀 요소. 주면 body로 포털해 `position: fixed`로 핀 사각형 아래(모자라면 위)에 두고, 창 안으로 민다
   * (`AnchoredPopover` · 핀이 pan/zoom으로 움직이면 따라감). 캔버스 무대는 확대 변환 · 잘라내기(overflow) 조상이라 그 안에 그리면
   * 무대 10%에서 칸이 22×10px로 작아지고, 좁은 곁 패널(무대 61px)에선 칸이 잘려 단추가 안 눌렸다. 없으면 `style` 자리에 그대로.
   */
  anchorRef?: RefObject<HTMLElement | null>;
}

/**
 * story #2725 — 새 좌표 코멘트 작성 팝오버. draft 핀 옆에 뜬다. Esc·바깥 클릭·취소 버튼 셋 다
 * onCancel(폐기, API 호출 0) — asset-picker-popover.tsx와 동형 바깥클릭 패턴(다음 프레임에
 * 리스너 등록 — 팝오버를 여는 그 클릭 자체가 바깥클릭으로 오인돼 즉시 닫히는 것 방지).
 */
export function CommentComposePopover({ onSubmit, onCancel, style, className, draftTargetId, anchorRef }: CommentComposePopoverProps) {
  const t = useTranslations('canvas');
  // story #4370 — 쓴 글은 산출물별 초안: Esc · 바깥 누름으로 닫혀도 남고 보이는 «취소» · 보내기 성공에서만 지운다(유나 규칙).
  const [body, setBody, clearBody] = useFieldDraft({ surface: 'artifact-comment-compose', targetId: draftTargetId, field: 'form' });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    let raf = 0;
    // story #4373 — 바깥 누름 판정은 공용 `isOutsidePress`(#4349): 쓰기 칸이 body 포털이라 칸 안 누름은 contains로 «안»이지만,
    // 칸 위에 또 뜬 포털 팝오버(`[data-anchored-popover]`) 안 누름도 «안»으로 세야 칸이 먼저 닫혀 그 메뉴 click을 삼키지 않는다.
    const handler = (e: MouseEvent) => {
      if (isOutsidePress(containerRef.current, e.target)) onCancel();
    };
    raf = requestAnimationFrame(() => document.addEventListener('mousedown', handler));
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', handler);
    };
  }, [onCancel]);

  // story #4373(까디르 실측) — 쓰기 칸이 무대 밖(body 포털)이라 휠이 무대 뷰포트의 네이티브 wheel 리스너(passive:false)를 안 거친다:
  // ctrl+휠이 캔버스 줌 대신 브라우저 페이지 줌으로, 그냥 휠이 캔버스 pan 대신 페이지 스크롤로 샜다. 칸 위 휠을 핀의 뷰포트로 넘긴다
  // (무대의 handleWheel이 그대로 pan/줌 · preventDefault) — 글 칸이 스스로 스크롤할 내용이 있는 그냥 휠만 칸 몫으로 둔다.
  useEffect(() => {
    const box = containerRef.current;
    if (!anchorRef || !box) return;
    const forward = (e: WheelEvent) => {
      const field = (e.target as HTMLElement | null)?.closest?.('textarea');
      if (!(e.ctrlKey || e.metaKey) && field && field.scrollHeight > field.clientHeight) return;
      e.preventDefault();
      const viewport = anchorRef.current?.closest('[data-artifact-canvas-viewport]');
      viewport?.dispatchEvent(new WheelEvent('wheel', {
        deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY,
        ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
      }));
    };
    box.addEventListener('wheel', forward, { passive: false });
    return () => box.removeEventListener('wheel', forward);
  }, [anchorRef]);

  function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    void onSubmit(trimmed).then((ok) => { if (ok) clearBody(); });
  }

  // story #3007(로드맵 P2·PR-E, L1) — 팝오버는 floating이라 --elev-overlay.
  const frameClass = `w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card p-2 shadow-[var(--elev-overlay)] outline-none ${className ?? ''}`;
  // [SID:4367] Esc = 이 칸만 닫음(폐기)·«썼다»고 표시 — 스토리 패널 안 산출물 카드에서 이 Esc가 패널 window Esc로 흘러 패널째 닫혔다.
  // [SID:4369] 유나 규칙 — 글이 있으면 첫 Esc는 칸에서만 빠져나옴(글 유지 · 초점 = 이 틀) · 조합 중 Esc는 조합만 · 둘째 Esc(또는 빈 칸) = 닫기.
  // story #4370 — 둘째 Esc도 글을 버리지 않는다(닫기만 · 초안으로 남음) · 버림은 보이는 «취소»로만.
  function handleFrameKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      if (leaveMultilineFieldOnEsc(e.nativeEvent, containerRef.current)) return;
      e.preventDefault();
      onCancel();
    }
  }

  const fields = (
    <>
      <textarea
        ref={inputRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
        }}
        placeholder={t('newThreadComposePlaceholder')}
        rows={2}
        // story #4373 — 화면 크기 그대로 읽히게(모바일 16px · 확대 방지).
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-base text-foreground lg:text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => { clearBody(); onCancel(); }}
          // story #4373 — 누름 영역 모바일 44px · 데스크톱 32px.
          className="min-h-11 rounded-md border border-border px-3 text-xs font-semibold text-muted-foreground hover:bg-muted sm:min-h-8"
        >
          {t('newThreadCancelAction')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="min-h-11 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 sm:min-h-8"
        >
          {t('newThreadSubmitAction')}
        </button>
      </div>
    </>
  );

  if (anchorRef) {
    return (
      // [SID:4369] 유나 규칙의 층 뿌리 — 글 있는 칸에서 빠져나온 초점이 여기로(tabIndex=-1).
      <AnchoredPopover anchorRef={anchorRef} popoverRef={containerRef} trackAnchor tabIndex={-1} onKeyDown={handleFrameKeyDown} className={`z-50 ${frameClass}`}>
        {fields}
      </AnchoredPopover>
    );
  }
  return (
    <div ref={containerRef} style={style} tabIndex={-1} onKeyDown={handleFrameKeyDown} className={`absolute z-20 ${frameClass}`}>
      {fields}
    </div>
  );
}
