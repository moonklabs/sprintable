'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, X } from 'lucide-react';
import { PresenceDot, WORKING_RING_CLASS, type PresenceStatus } from '@/components/chat/presence-dot';
import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';

// 2505d27d: 디디 #1356 `GET /api/v2/team-presence` 응답 계약(검증 완료·mismatch 0).
interface TeamPresenceItem {
  member_id: string;
  name: string;
  avatar_url?: string | null;
  agent_role?: string | null;
  runtime_type?: string | null;
  presence_status?: PresenceStatus | null;
  working: boolean;
  active_story?: { id: string; title: string; status: string } | null;
}

// ~2s 통합 폴 — working snappy(선생님 빠릿빠릿)·presence 충분. 패널 비가시 시 중단(낭비0).
const POLL_MS = 2000;

type GroupKey = 'working' | 'online' | 'offline';
const GROUP_DOT: Record<GroupKey, string> = {
  working: 'bg-brand',
  online: 'bg-success',
  offline: 'bg-muted-foreground/40',
};

function groupItems(items: TeamPresenceItem[]): { key: GroupKey; items: TeamPresenceItem[] }[] {
  const byName = (a: TeamPresenceItem, b: TeamPresenceItem) => a.name.localeCompare(b.name);
  const working = items.filter((i) => i.working).sort(byName);
  // online 그룹 = working 아님 + (online | idle). idle은 dot=amber로 구분(별 그룹 안 만듦·노이즈↓).
  const online = items.filter((i) => !i.working && (i.presence_status === 'online' || i.presence_status === 'idle')).sort(byName);
  const offline = items.filter((i) => !i.working && (i.presence_status === 'offline' || !i.presence_status)).sort(byName);
  return ([
    { key: 'working', items: working },
    { key: 'online', items: online },
    { key: 'offline', items: offline },
  ] as { key: GroupKey; items: TeamPresenceItem[] }[]).filter((g) => g.items.length > 0);
}

function PresenceRow({ item }: { item: TeamPresenceItem }) {
  const t = useTranslations('presence');
  const offline = !item.working && (item.presence_status === 'offline' || !item.presence_status);
  const dotStatus: PresenceStatus = item.presence_status ?? 'offline';
  const fallback = [item.agent_role, item.runtime_type].filter(Boolean).join(' · ');

  return (
    <li className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5', offline && 'opacity-60')}>
      <div className={cn('relative size-8 shrink-0 rounded-full', item.working && WORKING_RING_CLASS)}>
        {item.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.avatar_url} alt="" className="size-8 rounded-full object-cover" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-warning-tint text-warning">
            <Bot className="size-4" />
          </span>
        )}
        <PresenceDot status={dotStatus} size="md" className="absolute -bottom-0.5 -right-0.5" />
      </div>

      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-medium', offline ? 'text-muted-foreground' : 'text-foreground')}>
          {item.name}
        </p>
        <div className="truncate text-xs text-muted-foreground">
          {item.working ? (
            <span className="inline-flex max-w-full items-center gap-1 text-brand">
              <span className="shrink-0">{t('working')}</span>
              <span className="inline-flex shrink-0 gap-0.5" aria-hidden>
                <span className="size-1 rounded-full bg-brand motion-safe:animate-bounce" />
                <span className="size-1 rounded-full bg-brand motion-safe:animate-bounce [animation-delay:150ms]" />
                <span className="size-1 rounded-full bg-brand motion-safe:animate-bounce [animation-delay:300ms]" />
              </span>
              {item.active_story ? (
                <span className="truncate text-muted-foreground">· {t('assignedStory', { title: item.active_story.title })}</span>
              ) : null}
            </span>
          ) : item.active_story ? (
            t('assignedStory', { title: item.active_story.title })
          ) : (
            fallback
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * 2505d27d 팀 presence 패널 본체 — 상태별 그룹(🔵working↑→🟢online→⚫offline↓)·~2s 폴(active 시만).
 * contextual-panel-layout의 renderPanel로 inline(right-rail)/drawer 양쪽에서 렌더.
 */
export function TeamPresencePanel({
  active,
  mode = 'inline',
  onClose,
}: {
  active: boolean;
  mode?: 'inline' | 'drawer';
  onClose?: () => void;
}) {
  const t = useTranslations('presence');
  const [items, setItems] = useState<TeamPresenceItem[]>([]);

  const fetchPresence = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/team-presence');
      if (!res.ok) return;
      const json = (await res.json()) as TeamPresenceItem[] | { data?: TeamPresenceItem[] };
      setItems(Array.isArray(json) ? json : (json.data ?? []));
    } catch {
      /* non-critical */
    }
  }, []);

  // 패널이 active(open·가시)일 때만 폴 — 닫힘/비가시 시 중단(낭비0).
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPresence();
    const interval = setInterval(() => { void fetchPresence(); }, POLL_MS);
    return () => clearInterval(interval);
  }, [active, fetchPresence]);

  const groups = groupItems(items);

  return (
    <GlassPanel className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl">
      <header className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('panelTitle')}</h2>
        {mode === 'drawer' && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('panelTitle')}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="px-2 py-1">
              <div className="flex items-center gap-2 px-2 py-1">
                <span className={cn('size-2 rounded-full', GROUP_DOT[g.key])} aria-hidden />
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t(g.key === 'working' ? 'groupWorking' : g.key === 'online' ? 'groupOnline' : 'groupOffline')}
                </h3>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
              </div>
              <ul>
                {g.items.map((item) => (
                  <PresenceRow key={item.member_id} item={item} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </GlassPanel>
  );
}
