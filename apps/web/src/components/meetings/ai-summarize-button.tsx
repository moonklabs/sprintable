'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useAiSummarize } from '@/hooks/use-ai-summarize';

interface AiSummarizeButtonProps {
  meetingId: string;
  hasTranscript: boolean;
  guardedFetch?: typeof fetch;
  onResult?: (result: {
    summary: string;
    decisions: Array<{ id: string; text: string; owner?: string }>;
    action_items: Array<{ id: string; text: string; assignee?: string; due_date?: string; status?: string }>;
  }) => void;
}

export function AiSummarizeButton({ meetingId, hasTranscript, guardedFetch, onResult }: AiSummarizeButtonProps) {
  const t = useTranslations('meeting');
  const { summarize, cancel, isLoading, streamText, error, result } = useAiSummarize(meetingId, guardedFetch);

  const handleClick = async () => {
    await summarize();
  };

  // 결과 전달 (useEffect로 render 중 setState 방지)
  useEffect(() => {
    if (result && onResult) {
      onResult(result);
    }
  }, [result, onResult]);

  return (
    <div className="space-y-2">
      {/* AC1: AI Summarize 버튼 */}
      <div className="flex items-center gap-2">
        {!isLoading ? (
          <button
            onClick={handleClick}
            disabled={!hasTranscript}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ✨ {t('aiSummarize')}
          </button>
        ) : (
          <button
            onClick={cancel}
            className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
          >
            ⏹ {t('cancel')}
          </button>
        )}
        {!hasTranscript && (
          <span className="text-xs text-muted-foreground">{t('transcriptRequired')}</span>
        )}
      </div>

      {/* AC6: 에러 표시 (AC9: i18n) */}
      {error && (
        <p className="text-xs text-red-500">
          {error.includes('NO_API_KEY') ? t('aiKeyRequired')
            : error.includes('NO_TRANSCRIPT') ? t('transcriptRequired')
            : error.includes('Monthly') || error.includes('monthly') ? t('aiMonthlyLimit')
            : error.includes('429') || error.includes('token') || error.includes('limit') ? t('aiTokenLimit')
            : t('aiSummarizeError')}
        </p>
      )}

      {/* AC7: 스트리밍 텍스트 프리뷰 */}
      {isLoading && streamText && (
        <div className="rounded-lg border bg-primary/5 p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary/50" />
            <span className="text-xs font-medium text-primary">{t('aiSummarizing')}</span>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {streamText}
          </pre>
        </div>
      )}

      {isLoading && !streamText && (
        <div className="flex items-center gap-2 text-xs text-primary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary/50" />
          {t('aiSummarizing')}
        </div>
      )}
    </div>
  );
}
