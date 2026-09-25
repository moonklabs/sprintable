'use client';

import { useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import { ClipboardList } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatAtLeast } from '@/lib/format-at-least';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { parseCursorMeta } from '@/lib/pagination';
import { disambiguateFallbackLabels, memberLookup } from '@/lib/member-display';
import { fetchWithAuth } from '@/lib/db/client';
import { useMemberNameFallback } from '@/hooks/use-member-name-fallback';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

interface HistoryEntry {
  id: string;
  date: string;
  author_id: string;
  done: string | null;
  plan: string | null;
  blockers: string | null;
}

interface Props {
  projectId: string;
  memberNameById?: Record<string, string>;
  // [SID:4286] 부모의 이름 표를 다 불러왔는지 — 기록은 따로 불러와 표보다 먼저 그려질 수 있다.
  memberNamesLoaded: boolean;
}

export function StandupHistorySection({ projectId, memberNameById = {}, memberNamesLoaded }: Props) {
  const t = useTranslations('standup');
  const tCommon = useTranslations('common');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  // [SID:4300] 작성자 이름 = 부모 표(조직 범위 팀원 · 활성만 — 오늘 체크인 명단과 같은 목록) + 지난 기록 작성자가 거기 없을 때만
  // 비활성까지 싣는 조직 원천으로 보충(비활성 에이전트의 옛 기록). 부모 명단은 그대로.
  const { orgId } = useDashboardContext();
  const authorIds = useMemo(() => entries.map((e) => e.author_id), [entries]);
  const authorNames = useMemberNameFallback(orgId, memberNameById, authorIds, memberNamesLoaded);
  // [SID:4300 · PO 06:37Z] 같은 폴백 글자(«알 수 없는 구성원» 등)가 서로 다른 작성자 둘 이상에 서면 그 폴백에만 id 앞 8자 꼬리(#4284 · 겹칠 때만).
  const authorLabelById = useMemo(() => disambiguateFallbackLabels([...new Set(authorIds)].flatMap((id) => {
    const r = memberLookup(authorNames.memberMap, id, tCommon, { loaded: authorNames.loaded });
    return r ? [{ id, ...r }] : [];
  })), [authorIds, authorNames.memberMap, authorNames.loaded, tCommon]);
  const [loading, setLoading] = useState(true);
  // story #2248 — story-detail-panel.tsx의 활동/댓글 「더보기」 자리를 그대로 본뜬다(발명 금지).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    startTransition(() => setLoading(true));
    fetchWithAuth(`/api/standup/history?project_id=${projectId}&limit=20`)
      .then((r) => r.json())
      .then((json) => {
        if (json?.data && Array.isArray(json.data)) setEntries(json.data);
        setNextCursor(parseCursorMeta(json.meta, 'standup-history-section').nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchWithAuth(`/api/standup/history?project_id=${projectId}&limit=20&cursor=${encodeURIComponent(nextCursor)}`);
      if (res.ok) {
        const json = await res.json();
        setEntries((prev) => [...prev, ...(json.data ?? [])]);
        setNextCursor(parseCursorMeta(json.meta, 'standup-history-section:loadMore').nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, projectId]);

  if (loading || entries.length === 0) return null;

  const byDate: Record<string, HistoryEntry[]> = {};
  for (const e of entries) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  }
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  return (
    <section className="mt-8 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ClipboardList className="h-4 w-4" aria-hidden />
          {t('history')}
        </h2>
        {/* story #4302 — 20건씩 받는 목록이라 불러온 수는 전체가 아니다: 더 남았으면 «48+»(formatAtLeast · 유나 판정). 칩은 맨 수만
            (머리 «작성 이력»이 이미 무엇의 수인지 말한다 — 문장을 넣으면 en에서 «Standup»이 두 번). */}
        <Badge variant="chip">{formatAtLeast(entries.length, nextCursor !== null)}</Badge>
      </div>
      <div className="space-y-4">
        {sortedDates.map((date) => (
          <div key={date} className="rounded-lg border border-border bg-card p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{date}</p>
            <div className="space-y-2">
              {byDate[date].map((entry) => (
                <div key={entry.id} className="min-h-4 text-xs text-foreground/80">
                  {/* [SID:4286] 작성자 id 조각(앞 8자)을 이름 칸에 싣지 않는다 — 표에 없음 → «알 수 없는 구성원» · 불러오는 중 → 빈 칸. */}
                  <span className="font-medium">{authorLabelById.get(entry.author_id) ?? ''}</span>
                  {entry.done ? <span className="ml-2 text-muted-foreground">✅ {entry.done.slice(0, 80)}{entry.done.length > 80 ? '…' : ''}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {nextCursor ? (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => void handleLoadMore()} disabled={loadingMore}>
            {loadingMore ? tCommon('loading') : tCommon('loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
