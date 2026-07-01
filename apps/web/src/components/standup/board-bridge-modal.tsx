'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OperatorSelect } from '@/components/ui/operator-control';

export interface BoardBridgeStory {
  id: string;
  title: string;
  status: string;
}

export interface BoardBridgeBoard {
  projectId: string;
  projectName: string;
}

interface BoardBridgeModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  boards: BoardBridgeBoard[];
  alreadySelectedIds: string[];
  onSelectStory: (story: BoardBridgeStory, board: BoardBridgeBoard) => void;
}

// A1(9f27af8f): 보드 브릿지 — ① 접근 가능 보드 선택 → ② 그 보드 스토리(sprint_id 생략 → 백로그 포함) 선택.
// 기존 /api/projects·/api/stories 계약 재사용(BE 무변경) — projectMemberships는 useDashboardContext에서 이미 보유.
export function BoardBridgeModal({ open, onOpenChange, boards, alreadySelectedIds, onSelectStory }: BoardBridgeModalProps) {
  const t = useTranslations('standup');
  const [selectedBoardId, setSelectedBoardId] = useState('');
  const [stories, setStories] = useState<BoardBridgeStory[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedBoardId('');
      setStories([]);
      setLoadError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!selectedBoardId) { setStories([]); return; }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/stories?project_id=${selectedBoardId}&limit=40`);
        if (!res.ok) throw new Error('failed to load stories');
        const json = await res.json().catch(() => null) as { data?: BoardBridgeStory[] } | null;
        if (!cancelled) setStories(json?.data ?? []);
      } catch {
        if (!cancelled) setLoadError(t('bridgeLoadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedBoardId, t]);

  const selectedBoard = boards.find((b) => b.projectId === selectedBoardId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('bridgeModalTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('bridgeStepBoard')}
            </label>
            <OperatorSelect value={selectedBoardId} onChange={(e) => setSelectedBoardId(e.target.value)}>
              <option value="">{t('bridgeBoardPlaceholder')}</option>
              {boards.map((board) => (
                <option key={board.projectId} value={board.projectId}>{board.projectName}</option>
              ))}
            </OperatorSelect>
          </div>

          {selectedBoardId ? (
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('bridgeStepStory')}
              </label>
              {loading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((item) => (
                    <div key={item} className="h-12 animate-pulse rounded-lg bg-muted" />
                  ))}
                </div>
              ) : loadError ? (
                <p className="text-sm text-destructive">{loadError}</p>
              ) : stories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('bridgeNoStories')}</p>
              ) : (
                <div className="max-h-64 space-y-1.5 overflow-y-auto">
                  {stories.map((story) => {
                    const alreadyAdded = alreadySelectedIds.includes(story.id);
                    return (
                      <button
                        key={story.id}
                        type="button"
                        disabled={alreadyAdded}
                        onClick={() => selectedBoard && onSelectStory(story, selectedBoard)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/70 bg-background p-2.5 text-left transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{story.title}</span>
                        <Badge variant="outline">{alreadyAdded ? t('bridgeAlreadyAdded') : story.status}</Badge>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
