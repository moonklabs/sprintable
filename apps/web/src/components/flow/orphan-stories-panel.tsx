'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { NextMakerGoal, NextMakerStory } from './derive-next-maker';

interface OrphanStoriesPanelProps {
  orphanStories: NextMakerStory[];
  activeGoals: NextMakerGoal[];
  onSelectStory: (storyId: string) => void;
  onAssigned: (storyId: string, epicId: string) => void;
}

/**
 * story #2224 후속(2026-07-31, PO 판정 — 샘플 5건이 전부 "오늘 만든" 스토리였다). 「다음
 * 고르기」(이 목표의 다음은 무엇인가)와 «다른 물음»(이것은 어느 목표의 일인가)이라 별도
 * 패널·별도 행동([목표 정하기])으로 세운다. 첫 줄(헤드라인) «아래»에 별도 줄로 — 다른 축이라
 * 섞지 않는다(PO: "첫 줄 옆이 아니라 아래"). PATCH `/api/stories/{id}` body `{epic_id}` —
 * 기존 계약(updateStorySchema에 epic_id 이미 있음, 그라운딩 확認) 그대로, 새 BE 계약 불요.
 */
export function OrphanStoriesPanel({ orphanStories, activeGoals, onSelectStory, onAssigned }: OrphanStoriesPanelProps) {
  const t = useTranslations('flow');
  const [expanded, setExpanded] = useState(false);

  if (orphanStories.length === 0) return null;

  return (
    <div className="rounded-lg border border-dashed border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="text-[13px] text-foreground">
          {t('orphanSummary', { n: orphanStories.length })}
        </span>
        <span className="text-[11px] text-muted-foreground">{t('orphanHint')}</span>
      </button>
      {expanded && (
        <div className="space-y-1.5 border-t border-border bg-muted/30 px-3 py-3">
          {orphanStories.map((story) => (
            <OrphanRow
              key={story.id}
              story={story}
              activeGoals={activeGoals}
              onSelectStory={onSelectStory}
              onAssigned={onAssigned}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrphanRow({
  story, activeGoals, onSelectStory, onAssigned,
}: {
  story: NextMakerStory;
  activeGoals: NextMakerGoal[];
  onSelectStory: (storyId: string) => void;
  onAssigned: (storyId: string, epicId: string) => void;
}) {
  const t = useTranslations('flow');
  const [picking, setPicking] = useState(false);
  const [selectedEpicId, setSelectedEpicId] = useState('');
  const [assigning, setAssigning] = useState(false);

  const handleConfirm = useCallback(() => {
    if (!selectedEpicId) return;
    setAssigning(true);
    fetch(`/api/stories/${story.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epic_id: selectedEpicId }),
    })
      .then((r) => {
        if (r.ok) onAssigned(story.id, selectedEpicId);
      })
      .finally(() => setAssigning(false));
  }, [story.id, selectedEpicId, onAssigned]);

  return (
    <div className={`flex items-center gap-2.5 rounded-md border border-l-2 bg-card px-2.5 py-2 ${story.assigneeId ? 'border-l-primary' : 'border-l-border'}`}>
      <button type="button" onClick={() => onSelectStory(story.id)} className="min-w-0 flex-1 truncate text-left text-xs text-foreground">
        #{story.storyNumber} {story.title}
      </button>
      {story.assigneeId && <span className="shrink-0 text-[10.5px] text-primary">{t('nextPickReasonOwned')}</span>}
      {picking ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <select
            value={selectedEpicId}
            onChange={(e) => setSelectedEpicId(e.target.value)}
            className="rounded border border-border bg-card px-1.5 py-1 text-[11px]"
          >
            <option value="">{t('orphanPickPlaceholder')}</option>
            {activeGoals.map((g) => (
              <option key={g.id} value={g.id}>{g.title}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selectedEpicId || assigning}
            onClick={handleConfirm}
            className="focus-outset rounded-md border border-primary bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
          >
            {assigning ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : t('orphanAssignConfirm')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium"
        >
          {t('orphanPickAction')}
        </button>
      )}
    </div>
  );
}
