'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface CommitBarProps {
  changeCount: number;
  onCommit: (summary: string) => void;
  onDone?: () => void;
  className?: string;
}

/**
 * E-CANVAS C3 §2 — 커밋 바. 누적 변경 → "버전으로 저장"(요약 입력). 개별 딸깍은 버전이
 * 아니다(§4 감시-게이트 — raw 편집 나열 금지, E-VERIFY/C1/C2와 동일 원칙). 변경 0이면
 * 저장 버튼 비활성(빈 커밋 방지).
 */
export function CommitBar({ changeCount, onCommit, onDone, className }: CommitBarProps) {
  const t = useTranslations('canvas');
  const [summary, setSummary] = useState('');

  const handleCommit = () => {
    onCommit(summary.trim());
    setSummary('');
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <span className="text-[11px] text-muted-foreground">{t('changeCount', { count: changeCount })}</span>
        <input
          type="text"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={t('commitSummaryPlaceholder')}
          disabled={changeCount === 0}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleCommit}
          disabled={changeCount === 0}
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-40"
        >
          {t('commitAction')}
        </button>
        {onDone ? (
          <button type="button" onClick={onDone} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground">
            {t('doneToViewerAction')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
