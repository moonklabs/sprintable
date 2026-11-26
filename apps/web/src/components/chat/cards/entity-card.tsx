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
import type { EntityCardKind } from './card-kinds';
import { useCardSummary } from './use-card-summary';

/**
 * story 5034 (C4) — the card of an object the SERVER knows, drawn from «kind + reference» only. Everything on it is read for the person looking (use-card-summary.ts); the click opens the
 * side reading panel (the second tier — the same panel every chat link already opens), where the window-wide third tier lives. The title wraps (two lines, then cut) and never widens the card.
 */
export function EntityCard({ kind, refId }: { kind: EntityCardKind; refId: string }) {
  const flatHref = useFlatHref();
  const panel = useReadingPanel();
  const { summary, retry } = useCardSummary(kind, refId);
  if (summary.state !== 'ready') return <CardFrame state={summary.state} onRetry={retry} data-testid={`chat-card-${kind}`} />;

  const title = summary.title ?? refId;
  const statusLabel = summary.status ? translateEntityStatus(kind, summary.status) : null;
  // 대상-프로젝트: 카드에는 «종류 + 참조» 둘뿐이라 대상의 프로젝트를 모른다 — 이 주소는 옆 패널 아래쪽 «전체 보기» 폴백이고, 열린 미리보기가 응답의 자기 프로젝트로 다시 싣는다(embed-card의 EmbedCard와 같은 이유)
  const href = getEntityHref(kind, refId, flatHref);
  const open = panel ? () => panel.open({ kind: 'entity', entityType: kind, entityId: refId, title: summary.title, status: summary.status, href }) : undefined;
  return <EntityCardFace kind={kind} title={title} statusLabel={statusLabel} onOpen={open} />;
}

/** the drawn card (no reads): what the viewer sees once the server answered — also what the state showcase draws */
export function EntityCardFace({ kind, title, statusLabel, onOpen }: { kind: EntityCardKind; title: string; statusLabel: string | null; onOpen?: () => void }) {
  const t = useTranslations('chats');
  const body = (
    <>
      <EntityGlyph Icon={resolveEntityIcon(kind)} label={title} className="size-5 shrink-0 text-ds-ink-2" />
      <span className="min-w-0 flex-1 break-words text-ds-body font-medium text-ds-ink line-clamp-2">{title}</span>
      {statusLabel ? <Chip>{statusLabel}</Chip> : null}
    </>
  );
  return (
    <CardFrame state="ready" data-testid={`chat-card-${kind}`}>
      {onOpen ? (
        <Button variant="quiet" className="h-auto min-h-ds-control w-full justify-start gap-2 whitespace-normal px-3 py-2 text-left" aria-label={`${title} — ${t('cardOpen')}`} onClick={onOpen}>
          {body}
        </Button>
      ) : (
        <div className="flex min-h-ds-control w-full items-center gap-2 px-3 py-2">{body}</div>
      )}
    </CardFrame>
  );
}
