'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
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
}

/**
 * story #2725 — 새 좌표 코멘트 작성 팝오버. draft 핀 옆에 뜬다(호출부가 draft 핀과 같은 %
 * 좌표로 style을 넘긴다 — 좌표 계산은 이 컴포넌트 책임 밖). Esc·바깥 클릭·취소 버튼 셋 다
 * onCancel(폐기, API 호출 0) — asset-picker-popover.tsx와 동형 바깥클릭 패턴(다음 프레임에
 * 리스너 등록 — 팝오버를 여는 그 클릭 자체가 바깥클릭으로 오인돼 즉시 닫히는 것 방지).
 */
export function CommentComposePopover({ onSubmit, onCancel, style, className, draftTargetId }: CommentComposePopoverProps) {
  const t = useTranslations('canvas');
  // story #4370 — 쓴 글은 산출물별 초안: Esc · 바깥 누름으로 닫혀도 남고 보이는 «취소» · 보내기 성공에서만 지운다(유나 규칙).
  const [body, setBody, clearBody] = useFieldDraft({ surface: 'artifact-comment-compose', targetId: draftTargetId, field: 'form' });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    let raf = 0;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onCancel();
    };
    raf = requestAnimationFrame(() => document.addEventListener('mousedown', handler));
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', handler);
    };
  }, [onCancel]);

  function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    void onSubmit(trimmed).then((ok) => { if (ok) clearBody(); });
  }

  return (
    <div
      ref={containerRef}
      style={style}
      // story #3007(로드맵 P2·PR-E, L1) — 팝오버는 floating이라 --elev-overlay.
      className={`absolute z-20 w-56 rounded-lg border border-border bg-card p-2 shadow-[var(--elev-overlay)] outline-none ${className ?? ''}`}
      // [SID:4369] 유나 규칙의 층 뿌리 — 글 있는 칸에서 빠져나온 초점이 여기로(tabIndex=-1).
      tabIndex={-1}
      // [SID:4367] Esc = 이 칸만 닫음(폐기)·«썼다»고 표시 — 스토리 패널 안 산출물 카드에서 이 Esc가 패널 window Esc로 흘러 패널째 닫혔다.
      // [SID:4369] 유나 규칙 — 글이 있으면 첫 Esc는 칸에서만 빠져나옴(글 유지 · 초점 = 이 틀) · 조합 중 Esc는 조합만 · 둘째 Esc(또는 빈 칸) = 닫기.
      // story #4370 — 둘째 Esc도 글을 버리지 않는다(닫기만 · 초안으로 남음) · 버림은 보이는 «취소»로만.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (leaveMultilineFieldOnEsc(e.nativeEvent, containerRef.current)) return;
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <textarea
        ref={inputRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
        }}
        placeholder={t('newThreadComposePlaceholder')}
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => { clearBody(); onCancel(); }}
          className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted"
        >
          {t('newThreadCancelAction')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {t('newThreadSubmitAction')}
        </button>
      </div>
    </div>
  );
}
