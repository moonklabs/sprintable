'use client';

import type { ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ds/empty-state';
import { CardFrame } from './card-frame';
import { DeployCard } from './deploy-card';
import { EntityCard } from './entity-card';
import { KanbanCard } from './kanban-card';
import { RefusedCard } from './refused-card';
import { CARD_KINDS, isEntityCardKind, parseCardRef, type CardKind } from './card-kinds';

/**
 * story 5034 (C4) — the catalogue: for every kind of the closed vocabulary, the one part that draws it (or `null` = this build has no part for it yet). A `Record<CardKind, …>` — a kind
 * added to card-kinds.ts does not compile until it is given a part or an explicit `null`, so no kind can be «forgotten». The agent chooses a kind; it never chooses how it looks.
 * `gate` is drawn by the approval card's own road (the message's `approval_target`) · `kanban` = the board of a sprint (its reference is the sprint's id) · `deploy` = «넣기 · 빼기» of one agent (its reference is the agent's member id) in the current project.
 */
type CardPart = ComponentType<{ kind: CardKind; refId: string }>;
const EntityPart: CardPart = ({ kind, refId }) => (isEntityCardKind(kind) ? <EntityCard kind={kind} refId={refId} /> : null);
const KanbanPart: CardPart = ({ refId }) => <KanbanCard sprintId={refId} />;
const DeployPart: CardPart = ({ refId }) => <DeployCard agentId={refId} />;

export const CARD_PARTS: Readonly<Record<CardKind, CardPart | null>> = {
  story: EntityPart,
  epic: EntityPart,
  task: EntityPart,
  sprint: EntityPart,
  doc: EntityPart,
  artifact: EntityPart,
  hypothesis: EntityPart,
  evidence: EntityPart,
  gate: null,
  kanban: KanbanPart,
  deploy: DeployPart,
};

/** the card of a kind this build cannot draw (an older app meeting a newer server · a kind with no part yet) — said as such, never an empty hole and never a guess */
export function UnknownCard() {
  const t = useTranslations('chats');
  return (
    <CardFrame state="ready" data-testid="chat-card-unknown">
      <EmptyState size="inline" title={t('cardUnknownTitle')} description={t('cardUnknownHint')} />
    </CardFrame>
  );
}

/** a message's `card` field (whatever the server sent) → its card. Anything that is not a known kind with a UUID reference is the unknown card. */
export function ChatCard({ card }: { card: unknown }) {
  const ref = parseCardRef(card);
  const Part = ref ? CARD_PARTS[ref.kind] : null;
  if (!ref || !Part) return <UnknownCard />;
  // a REFUSED card (the server posted it for an agent that may not see the object): drawn for each viewer by their own rights — only the kinds the show-card tool can post
  if (ref.refusedFor) return isEntityCardKind(ref.kind) || ref.kind === 'kanban' ? <RefusedCard kind={ref.kind} refId={ref.ref} agentId={ref.refusedFor} /> : <UnknownCard />;
  return <Part kind={ref.kind} refId={ref.ref} />;
}

export { CARD_KINDS };
