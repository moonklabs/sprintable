'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';

// Operator Cockpit Phase A2-MIN — pending decisions panel.
// Reads from /api/inbox (inbox_items) and lets the operator resolve or dismiss
// each item. Notifications panel stays untouched below for transition period.

interface OriginNode {
  type: 'memo' | 'story' | 'run' | 'initiative';
  id: string;
}

interface InboxOption {
  id: string;
  label: string;
  kind: 'approve' | 'approve-alt' | 'reassign' | 'changes';
  consequence: string;
}

interface InboxItem {
  id: string;
  org_id: string;
  project_id: string;
  kind: 'approval' | 'decision' | 'blocker' | 'mention';
  title: string;
  agent_summary?: string | null;
  origin_chain: OriginNode[];
  options: InboxOption[];
  priority: 'high' | 'normal';
  state: 'pending' | 'resolved' | 'dismissed';
  created_at: string;
}

interface InboxListResponse {
  data: InboxItem[];
  meta?: {
    pendingCount?: number;
    countsByKind?: Record<string, number>;
  };
}

const ORIGIN_LABEL: Record<OriginNode['type'], string> = {
  memo: 'Memo',
  story: 'Story',
  run: 'Run',
  initiative: 'Initiative',
};

interface DecisionsWaitingProps {
  onChange?: () => void;
}

export function DecisionsWaiting({ onChange }: DecisionsWaitingProps = {}) {
  const t = useTranslations('inbox');
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    setError(null);
    try {
      // story #2689 — 콜드 재진입 시 raw fetch는 401을 재시도 없이 삼켜(아래 return) 이
      // 패널이 영구히 비어 보였다. fetchWithAuth로 401→refresh→재시도 경로에 태운다 — 그래도
      // 401이면(refresh 자체 실패) signalSessionExpired가 이미 전역 다이얼로그를 띄우므로
      // 여기선 그대로 조용히 return.
      const res = await fetchWithAuth('/api/inbox?state=pending');
      if (!res.ok) {
        if (res.status === 401) return;
        setError('fetch_failed');
        return;
      }
      const json = (await res.json()) as InboxListResponse;
      setItems(json.data ?? []);
    } catch {
      setError('fetch_failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const removeLocally = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    onChange?.();
  };

  const resolve = async (item: InboxItem, optionId: string) => {
    setPending((p) => ({ ...p, [item.id]: true }));
    try {
      const res = await fetch(`/api/inbox/${item.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: optionId }),
      });
      if (res.ok || res.status === 409) {
        // 409 means someone else already resolved it — drop from local view
        removeLocally(item.id);
      } else {
        setError('resolve_failed');
      }
    } catch {
      setError('resolve_failed');
    } finally {
      setPending((p) => ({ ...p, [item.id]: false }));
    }
  };

  const dismiss = async (item: InboxItem) => {
    setPending((p) => ({ ...p, [item.id]: true }));
    try {
      const res = await fetch(`/api/inbox/${item.id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok || res.status === 409) {
        removeLocally(item.id);
      } else {
        setError('dismiss_failed');
      }
    } catch {
      setError('dismiss_failed');
    } finally {
      setPending((p) => ({ ...p, [item.id]: false }));
    }
  };

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <section
      data-testid="decisions-waiting"
      className="mx-3 mt-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2"
    >
      <header className="mb-2 flex items-center gap-2">
        {/* story #2590(TIER1 아이콘) — text-warning은 tint 유무와 무관하게 3.0 미달(실측,
            #2420 doc) — text-foreground로 잠정 통일(진한 토큰 신설은 범위 밖). */}
        <AlertTriangle className="size-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          {t('decisionsWaiting')}
        </h2>
        <Badge variant="outline" className="tabular-nums">
          {items.length}
        </Badge>
      </header>

      {error ? (
        <p className="mb-2 text-xs text-foreground" role="alert">
          {t('decisionsErrorRetry')}
        </p>
      ) : null}

      <ul className="space-y-2">
        {items.map((item) => {
          const isBusy = !!pending[item.id];
          return (
            <li
              key={item.id}
              data-testid={`decision-item-${item.id}`}
              className="rounded-xl border border-white/8 bg-muted/55 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {item.kind}
                    </Badge>
                    {item.priority === 'high' ? (
                      <Badge className="bg-destructive/15 text-foreground text-[10px] uppercase">
                        {t('priorityHigh')}
                      </Badge>
                    ) : null}
                    {item.origin_chain.length > 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        {item.origin_chain
                          .map((n) => `${ORIGIN_LABEL[n.type]} · ${n.id.slice(0, 8)}`)
                          .join(' → ')}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {item.title}
                  </p>
                  {item.agent_summary ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {item.agent_summary}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('dismiss')}
                  disabled={isBusy}
                  onClick={() => void dismiss(item)}
                >
                  <X className="size-4" />
                </Button>
              </div>

              {item.options.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.options.map((opt) => (
                    <Button
                      key={opt.id}
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => void resolve(item, opt.id)}
                      title={opt.consequence}
                    >
                      <CheckCircle2 className="mr-1 size-3" />
                      {opt.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
