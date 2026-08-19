'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

interface CommentComposePopoverProps {
  onSubmit: (body: string) => void;
  onCancel: () => void;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * story #2725 — 새 좌표 코멘트 작성 팝오버. draft 핀 옆에 뜬다(호출부가 draft 핀과 같은 %
 * 좌표로 style을 넘긴다 — 좌표 계산은 이 컴포넌트 책임 밖). Esc·바깥 클릭·취소 버튼 셋 다
 * onCancel(폐기, API 호출 0) — asset-picker-popover.tsx와 동형 바깥클릭 패턴(다음 프레임에
 * 리스너 등록 — 팝오버를 여는 그 클릭 자체가 바깥클릭으로 오인돼 즉시 닫히는 것 방지).
 */
export function CommentComposePopover({ onSubmit, onCancel, style, className }: CommentComposePopoverProps) {
  const t = useTranslations('canvas');
  const [body, setBody] = useState('');
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
    onSubmit(trimmed);
  }

  return (
    <div
      ref={containerRef}
      style={style}
      className={`absolute z-20 w-56 rounded-lg border border-border bg-card p-2 shadow-md ${className ?? ''}`}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
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
          onClick={onCancel}
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
