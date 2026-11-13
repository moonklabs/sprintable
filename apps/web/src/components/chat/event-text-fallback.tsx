'use client';

import { useTranslations } from 'next-intl';
import { composeEventBodyFallback } from './event-block-card';

// the bubble has no organization domain labels at hand (reading them per bubble would be one request per message): a status the org renamed shows the standard label, an unknown slug shows as it is
const NO_DOMAIN_LABELS = { statusLabel: () => undefined, entityTypeLabel: () => undefined };

/**
 * story 4921 — the body of a chat bubble / v3 message for an event message drawn as text (no card template · definitions unread · an old message): the head, the person's own words and the other fields as a
 * readable list. The machine header («[이벤트] preset.x») and raw key names never show; the content is not dropped.
 */
export function EventTextFallback({ content, eventKey, payload, refs, definition, eventDefinitionName }: {
  content: string;
  eventKey?: string;
  payload?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  definition?: { name?: string | null; payload_schema?: Record<string, unknown> } | null;
  eventDefinitionName?: (key: string) => string | undefined;
}) {
  const tChats = useTranslations('chats');
  const tBoard = useTranslations('board');
  const tCage = useTranslations('cage');
  const tDashboard = useTranslations('dashboard');
  const tEventCard = useTranslations('eventCard');
  const tOutcomeLoop = useTranslations('outcomeLoop');
  const domainLabels = NO_DOMAIN_LABELS;
  const model = composeEventBodyFallback(content, eventKey, payload, refs, definition, {
    tBoard, tCage, tDashboard, tEventCard, tEntity: tChats, tOutcomeLoop, domainLabels, eventDefinitionName,
  });
  if (!model) return null;
  return (
    <div data-testid="event-text-fallback" className="min-w-0 space-y-1">
      <p className="font-medium">{model.head}</p>
      {model.words ? <p className="whitespace-pre-wrap">{model.words}</p> : null}
      {model.items.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {model.items.map((it, i) => (
            <li key={`${it.label}-${i}`}><span className="text-muted-foreground">{it.label}</span>{': '}{it.value}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
