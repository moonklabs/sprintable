'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  buildNowFace, parseCompletionNotifications, parseMyActions,
  type NowFaceItem, type NowFaceTranslator,
} from './derive-now-face';

// story ded31cb3 — 조직 브리핑 "지금" 면. doc org-briefing-hypothesis-grammar-blueprint §1.3.
// 기본 5 + "+N 더" 인라인 펼침(⛔우선순위 컷 금지 — nod 확定②: 초과분 숨김은 정보 은닉이라 폐기).
const CAP = 5;
const REFRESH_MS = 60_000;

async function loadNowFace(t: NowFaceTranslator): Promise<NowFaceItem[]> {
  const [ma, notifs] = await Promise.all([
    fetch('/api/dashboard/my-actions').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/notifications?type=task_completed&unread=true').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return buildNowFace(parseMyActions(ma), parseCompletionNotifications(notifs), t);
}

function KindBadge({ kind, label }: { kind: NowFaceItem['kind']; label: string }) {
  const variant = kind === 'done' ? 'success' : 'info';
  return (
    <Badge variant={variant} className="w-[92px] shrink-0 justify-center whitespace-nowrap">
      {label}
    </Badge>
  );
}

function NowRow({ item }: { item: NowFaceItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-center gap-3 border-t border-border px-3 py-3 transition-colors first:border-t-0 hover:bg-muted/50"
    >
      <KindBadge kind={item.kind} label={item.kindLabel} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">{item.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.context}</span>
      </span>
      <span
        className={cn(
          'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium',
          item.actionTone === 'primary'
            ? 'bg-primary text-primary-foreground'
            : 'border border-border text-foreground',
        )}
      >
        {item.actionLabel}
      </span>
    </Link>
  );
}

function RowSkeleton() {
  return <div className="h-[60px] animate-pulse border-t border-border bg-muted/30 first:border-t-0" />;
}

export function NowFace() {
  const t = useTranslations('orgBriefing');
  const [items, setItems] = useState<NowFaceItem[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const load = async () => {
      const result = await loadNowFace(t);
      setItems(result);
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [t]);

  const list = items ?? [];
  const shown = expanded ? list : list.slice(0, CAP);
  const overflow = Math.max(0, list.length - CAP);

  return (
    <section aria-label={t('nowTitle')}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('nowTitle')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('nowSubject')}</span>
        {items && items.length > 0 ? (
          <span className="ml-auto text-[11px] text-muted-foreground">{t('nowNote', { count: items.length })}</span>
        ) : null}
      </div>
      <div className="rounded-2xl border border-border bg-card">
        {items === null ? (
          Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
            <CheckCircle2 className="size-5 text-success/70" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">{t('nowEmptyTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('nowEmptyBody')}</p>
          </div>
        ) : (
          <>
            {shown.map((item) => (
              <NowRow key={item.id} item={item} />
            ))}
            {!expanded && overflow > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full border-t border-border px-3 py-2.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('nowMore', { count: overflow })}
              </button>
            ) : null}
          </>
        )}
      </div>
      {items && list.length > 0 ? (
        <p className="mt-2 px-1 text-[11.5px] text-muted-foreground">{t('nowFoot')}</p>
      ) : null}
    </section>
  );
}
