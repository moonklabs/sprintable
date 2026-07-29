'use client';

import { useTranslations } from 'next-intl';

export type CitationSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface CitationComposeBarProps {
  mode: 'anchored' | 'confirming';
  selectedCount: number;
  saveState: CitationSaveState;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * story #2265(C-7) 저장 조각 — 메시지 범위 선택 중/확定 후 뜨는 얇은 바. `mode==='anchored'`
 * (아직 끝을 안 골랐음)일 때는 안내만, `mode==='confirming'`(범위 확定됨)일 때 저장 액션이
 * 뜬다. 저장은 이 컴포넌트 밖(chat-view)에서 스토리 피커를 여는 것으로 이어진다 — 이 바는
 * 상태만 그린다(새 피커를 여기 만들지 않는다, 기존 StoryPickerDialog 재사용).
 */
export function CitationComposeBar({ mode, selectedCount, saveState, onCancel, onSave }: CitationComposeBarProps) {
  const t = useTranslations('chats');

  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-2">
      <span className="text-xs text-muted-foreground">
        {mode === 'anchored' ? t('citationAnchored') : t('citationSelectedCount', { count: selectedCount })}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {saveState === 'saved' ? (
          <span className="text-xs font-medium text-success">{t('citationSaved')}</span>
        ) : (
          <>
            {saveState === 'error' ? <span className="text-xs text-destructive">{t('citationSaveFailed')}</span> : null}
            <button
              type="button"
              onClick={onCancel}
              disabled={saveState === 'saving'}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted disabled:opacity-50"
            >
              {t('citationCancel')}
            </button>
            {mode === 'confirming' ? (
              <button
                type="button"
                onClick={onSave}
                disabled={saveState === 'saving'}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              >
                {saveState === 'saving' ? t('citationSaving') : t('citationSaveToStory')}
              </button>
            ) : null}
          </>
        )}
      </span>
    </div>
  );
}
