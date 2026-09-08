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
import { Input } from '@/components/ui/input';
import { OperatorSelect } from '@/components/ui/operator-control';
import { fetchWithAuth } from '@/lib/db/client';

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
//
// story #3703(FE 완전성-정직, 유나 § 2026-09-08) — limit=40 단발 fetch라 40번째 밖 story는
// 이 픽커로 영영 못 골랐다(이 프로젝트만 3700+건). story-picker-dialog.tsx(canvas) 패턴
// 그대로 이식 — Input+250ms 디바운스+`q` 파라미터(프록시가 이미 받음, BE 변경 0), limit=40은
// 유지(검색이 도달을 보장하니 상한 자체를 올릴 필요가 없다 — 유나 明示 "상한 안내 문구는
// 잡음"). 빈 상태는 질의 유무로 갈라 "검색했는데 없다"와 "이 보드에 원래 없다"를 구분한다.
export function BoardBridgeModal({ open, onOpenChange, boards, alreadySelectedIds, onSelectStory }: BoardBridgeModalProps) {
  const t = useTranslations('standup');
  const [selectedBoardId, setSelectedBoardId] = useState('');
  const [query, setQuery] = useState('');
  const [stories, setStories] = useState<BoardBridgeStory[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedBoardId('');
      setQuery('');
      setStories([]);
      setLoadError(null);
    }
  }, [open]);

  useEffect(() => {
    setQuery('');
  }, [selectedBoardId]);

  useEffect(() => {
    if (!selectedBoardId) { setStories([]); return; }
    let cancelled = false;
    // story-picker-dialog.tsx와 동형 — setLoading을 디바운스 콜백 안에 둬 effect 본문
    // 동기 setState를 피한다(react-hooks/set-state-in-effect).
    const handle = setTimeout(() => {
      setLoading(true);
      setLoadError(null);
      void (async () => {
        const params = new URLSearchParams({ project_id: selectedBoardId, limit: '40' });
        if (query.trim()) params.set('q', query.trim());
        try {
          const res = await fetchWithAuth(`/api/stories?${params.toString()}`);
          if (!res.ok) throw new Error('failed to load stories');
          const json = await res.json().catch(() => null) as { data?: BoardBridgeStory[] } | null;
          if (!cancelled) setStories(json?.data ?? []);
        } catch {
          if (!cancelled) setLoadError(t('bridgeLoadFailed'));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [selectedBoardId, query, t]);

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
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('bridgeSearchPlaceholder')}
                className="mb-2"
              />
              {loading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((item) => (
                    <div key={item} className="h-12 animate-pulse rounded-lg bg-muted" />
                  ))}
                </div>
              ) : loadError ? (
                <p className="text-sm text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{loadError}</p>
              ) : stories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{query.trim() ? t('bridgeSearchNoResults') : t('bridgeNoStories')}</p>
              ) : (
                <div className="focus-inset max-h-64 space-y-1.5 overflow-y-auto">
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
