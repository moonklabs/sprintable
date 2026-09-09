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
import { parseCursorMeta } from '@/lib/pagination';

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
  // story #3703 CHANGES(유나 재-design, 2026-09-08 — blocking) — 디바운스로 fetch를 옮기며
  // setLoading(true)도 250ms 지연 안에 들어가, 보드 선택 직후 250ms는 loading=false인데
  // stories/loadError는 "이전 보드"(또는 최초 [])의 값 그대로다 — 그 창에서 화면이 「이
  // 보드에 스토리가 없다」를 물어보지도 않고 단정하거나(첫 진입), 심하면 A보드 목록이
  // B보드인 양 보여 그 행을 클릭하면 onSelectStory(A스토리, B보드) 어긋난 짝으로 잘못된
  // 연결이 실제로 생긴다(#4052와 같은 클래스 — fix 자신이 새로 연 「모르는 것을 아는 척」
  // 창). loadedKey=「이 (보드,질의) 조합의 응답이 실제로 도착했다」를 별도로 추적해
  // settled로만 렌더 분기한다(loading 플래그 단독 신뢰 안 함).
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // story #3706(FE 완전성-정직) — /api/stories 프록시(cursor 분기)는 limit=40 오버페치로
  // meta.hasMore를 항상 준다(route.ts, buildCursorPageMeta). 예전엔 json?.data만 읽고
  // 이 값을 버려서, 일치가 40건을 넘어도 검색 상자가 있다는 이유만으로 "이게 전부"처럼
  // 보였다 — hasMore일 때만 뜨는 조건부 한 줄로 그 갭을 닫는다.
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedBoardId('');
      setQuery('');
      setStories([]);
      setLoadError(null);
      setLoadedKey(null);
      setHasMore(false);
    }
  }, [open]);

  useEffect(() => {
    setQuery('');
  }, [selectedBoardId]);

  useEffect(() => {
    // story #3703 CHANGES(카디르 재-QA blocker②-2, 2026-09-09) — 무효화를 «완전 해제»
    // 분기 하나에만 걸어두면, 부분 일치(A→B→A를 디바운스 250ms 안에 왕복하거나 검색어를
    // ''→'x'→''로 왕복)에서 loadedKey가 훨씬 전의 옛 값과 우연히 같은 문자열이 돼
    // settled=true로 오판한다(카디르가 head에 재현 테스트 2건을 얹어 둘 다 FAIL 실증).
    // 불변식은 「어떤 선택 변경이든 그 순간부터 그 변경 자신의 응답이 닿을 때까지
    // settled=false」다 — 그래서 이 effect가 재실행되는 매 순간(=의존성이 바뀔 때마다)
    // 첫 줄에서 무효화한다. 「완전 해제」도 이 재실행에 포함되므로 별도 처리가 필요 없다.
    setLoadedKey(null);
    if (!selectedBoardId) { setStories([]); setHasMore(false); return; }
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
          const json = await res.json().catch(() => null) as { data?: BoardBridgeStory[]; meta?: unknown } | null;
          if (!cancelled) {
            setStories(json?.data ?? []);
            setHasMore(parseCursorMeta(json?.meta, 'BoardBridgeModal stories').hasMore);
          }
        } catch {
          if (!cancelled) { setLoadError(t('bridgeLoadFailed')); setHasMore(false); }
        } finally {
          if (!cancelled) {
            setLoading(false);
            setLoadedKey(`${selectedBoardId}|${query.trim()}`);
          }
        }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [selectedBoardId, query, t]);

  const selectedBoard = boards.find((b) => b.projectId === selectedBoardId) ?? null;
  const settled = loadedKey === `${selectedBoardId}|${query.trim()}`;

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
              {loading || !settled ? (
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
                <>
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
                  {hasMore ? (
                    <p className="mt-2 text-center text-xs text-muted-foreground">{t('bridgeMoreResults')}</p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
