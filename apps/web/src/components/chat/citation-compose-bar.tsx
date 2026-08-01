'use client';

import { useTranslations } from 'next-intl';

// story #2265(C-7), PO 지적(2026-07-29): 실패를 하나로 뭉치면 「권한 없음」과 「범위가
// 큼」과 「네트워크 끊김」이 같은 말이 되어 사용자가 무엇을 고쳐야 할지 못 판단한다 —
// 원인별로 상태를 가른다(문구는 임시, 유나군 확定 대기).
export type CitationSaveState = 'idle' | 'saving' | 'saved' | 'error_permission' | 'error_invalid' | 'error_network';

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
const ERROR_STATES: CitationSaveState[] = ['error_permission', 'error_invalid', 'error_network'];

// 원인별 임시 문구 — i18n 키가 아니라 이 자리에서 직접 가른다(유나군이 최종 카피를 정할 때까지
// 셋을 실제로 다른 문자열로 보이게 하는 것 자체가 이 슬라이스의 목적).
const ERROR_TEXT: Record<'error_permission' | 'error_invalid' | 'error_network', string> = {
  error_permission: '저장 실패 — 이 대화에 접근할 권한이 없습니다',
  error_invalid: '저장 실패 — 선택한 범위를 처리할 수 없습니다',
  error_network: '저장 실패 — 네트워크를 확인하고 다시 시도해 주세요',
};

export function CitationComposeBar({ mode, selectedCount, saveState, onCancel, onSave }: CitationComposeBarProps) {
  const t = useTranslations('chats');
  const isError = ERROR_STATES.includes(saveState);

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
            {isError ? <span className="text-xs text-destructive">{ERROR_TEXT[saveState as 'error_permission' | 'error_invalid' | 'error_network']}</span> : null}
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
