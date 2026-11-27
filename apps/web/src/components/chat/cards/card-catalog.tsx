'use client';

import type { ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { CardFrame } from './card-frame';
import { AgentActionCard } from './agent-action-card';
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
const AgentActionPart: CardPart = ({ refId }) => <AgentActionCard requestId={refId} />;

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
  agent_action: AgentActionPart,
};

/** the card of a kind this build cannot draw (an older app meeting a newer server · a kind with no part yet) — said as such, never an empty hole and never a guess */
export function UnknownCard() {
  const t = useTranslations('chats');
  return (
    <CardFrame state="ready" data-testid="chat-card-unknown">
      {/* a supporting size, like «찾을 수 없어요»: a card this build cannot draw is not the loudest thing in a room */}
      <div className="flex flex-col gap-0.5 px-3 py-3">
        <p className="m-0 text-ds-small text-ds-ink-2">{t('cardUnknownTitle')}</p>
        <p className="m-0 text-ds-small text-ds-ink-3">{t('cardUnknownHint')}</p>
      </div>
    </CardFrame>
  );
}

/** a message's `card` field (whatever the server sent) → its card. Anything that is not a known kind with a UUID reference is the unknown card. */
export function ChatCard({ card }: { card: unknown }) {
  const ref = parseCardRef(card);
  if (!ref) return <UnknownCard />;
  // a REFUSED card (the server posted it for an agent that may not see the object): drawn for each viewer by their own rights. An object or a board is read for the viewer (RefusedCard); any OTHER kind
  // (a project-membership card of an agent · a gate) is the plain «찾을 수 없어요», drawn EXACTLY as that kind's ordinary «not found» card (same frame and test id — the DOM must not tell «refused» from «missing») — whatever must stay hidden the server never sent, and «update the app» would be a wrong thing to say about a card this build knows
  if (ref.refusedFor) return isEntityCardKind(ref.kind) || ref.kind === 'kanban' ? <RefusedCard kind={ref.kind} refId={ref.ref} agentId={ref.refusedFor} /> : <CardFrame state="hidden" data-testid={ref.kind === 'deploy' ? 'chat-card-deploy' : undefined} />;
  const Part = CARD_PARTS[ref.kind];
  if (!Part) return <UnknownCard />;
  return <Part kind={ref.kind} refId={ref.ref} />;
}

export { CARD_KINDS };
