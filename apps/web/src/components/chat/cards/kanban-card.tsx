'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { EntityGlyph, resolveEntityIcon } from '@/components/chat/entity-registry';
import { getEntityHref } from '@/components/chat/embed-card';
import { translateEntityStatus } from '@/components/chat/entity-status-labels';
import { useReadingPanel } from '@/components/chat/reading-panel-context';
import { useFlatHref } from '@/hooks/use-flat-href';
import { CardFrame } from './card-frame';
import { KANBAN_COLUMNS, fetchKanbanSummary, type KanbanSummary } from './kanban-summary';
import { useCardRead } from './use-card-read';

/**
 * story 5034 (C4 step 3) — the board card of a SPRINT (the card's reference is the sprint's id): its name, how many stories stand in each column and the few being worked on. Read-only — a
 * card shows the board, it never moves a story. Everything on it is read for the person looking; pressing the head opens the sprint in the side panel (the second tier).
 */
export function KanbanCard({ sprintId }: { sprintId: string }) {
  const flatHref = useFlatHref();
  const panel = useReadingPanel();
  const { read, retry } = useCardRead(`kanban:${sprintId}`, () => fetchKanbanSummary(sprintId));
  if (read.state !== 'ready') return <CardFrame state={read.state} onRetry={retry} data-testid="chat-card-kanban" />;
  const s = read.value;
  if (s.total === 0) return <CardFrame state="empty" data-testid="chat-card-kanban" />;
  // 대상-프로젝트: 카드에는 «종류 + 참조» 둘뿐이라 스프린트의 프로젝트를 모른다 — 이 주소는 옆 패널 아래쪽 «전체 보기» 폴백이고, 열린 미리보기가 응답의 자기 프로젝트로 다시 싣는다(EmbedCard와 같은 이유)
  const href = getEntityHref('sprint', sprintId, flatHref);
  const open = panel ? () => panel.open({ kind: 'entity', entityType: 'sprint', entityId: sprintId, title: s.title, status: s.status, href }) : undefined;
  return <KanbanCardFace summary={s} onOpen={open} />;
}

/** the drawn board (no reads) — also what a state showcase may draw */
export function KanbanCardFace({ summary, onOpen }: { summary: KanbanSummary; onOpen?: () => void }) {
  const t = useTranslations('chats');
  const title = summary.title ?? '';
  const head = (
    <>
      <EntityGlyph Icon={resolveEntityIcon('sprint')} label={title || 'sprint'} className="size-5 shrink-0 text-ds-ink-2" />
      <span className="min-w-0 flex-1 break-words text-ds-body font-medium text-ds-ink line-clamp-2">{title}</span>
      <span className="shrink-0 text-ds-small text-ds-ink-3">{t('kanbanTotal', { count: summary.total })}{summary.hasMore ? '+' : ''}</span>
    </>
  );
  return (
    <CardFrame state="ready" data-testid="chat-card-kanban">
      {onOpen ? (
        <Button variant="quiet" className="h-auto min-h-ds-control w-full justify-start gap-2 whitespace-normal px-3 py-2 text-left" aria-label={`${title} — ${t('kanbanOpen')}`} onClick={onOpen}>{head}</Button>
      ) : (
        <div className="flex min-h-ds-control w-full items-center gap-2 px-3 py-2">{head}</div>
      )}
      <ul className="m-0 grid list-none grid-cols-5 gap-1 px-3 pb-2 pt-0" data-testid="chat-card-kanban-columns">
        {KANBAN_COLUMNS.map((c) => (
          <li key={c} data-column={c} className="flex min-w-0 flex-col items-start gap-0.5 rounded-ds-control border border-ds-line bg-ds-surface-sunk px-2 py-1">
            <span className="text-ds-small text-ds-ink-3 break-keep">{translateEntityStatus('story', c)}</span>
            <span className="text-ds-body font-medium text-ds-ink">{summary.counts[c]}</span>
          </li>
        ))}
      </ul>
      {summary.now.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-ds-line px-3 py-2" data-testid="chat-card-kanban-now">
          <span className="text-ds-small text-ds-ink-3">{t('kanbanNow')}</span>
          {summary.now.map((n) => (
            <span key={n.id} className="flex min-w-0 items-center gap-1.5 text-ds-small text-ds-ink">
              {n.number !== null ? <Chip mono>{n.number}</Chip> : null}
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
            </span>
          ))}
        </div>
      ) : null}
    </CardFrame>
  );
}

