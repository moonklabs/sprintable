'use client';

import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { DeliveryDecision } from '@/hooks/use-chat-sse';

/**
 * story 5032 (C2) — under the sender's own line: WHO the message really went to, from the server's own delivery decision (not a guess from the text):
 *  - some of the room's agents got it and some did not → «→ @A · @B에게만 전달» (the delivered ones, by name; more than three → «@A · @B 외 N»);
 *  - no agent got it → «→ 사람들에게만 전달 — 에이전트에게는 안 가요» (or, when no person got it either, «→ 에이전트에게는 안 가요»);
 *  - every agent got it, or the room has no agent → no line (nothing to say).
 * Muted, no red, no button (there is nothing to do) — like the blocked-delivery line beside it. Only the sender's own message; the server sends the field to the sender only and callers pass `isMine` too.
 * `nameOf` looks an agent up by member id (the room's participants); an unknown id is dropped from the names and counted.
 */
const MAX_NAMES = 3;

export function DeliveryDecisionLine({ decision, isMine, nameOf }: { decision: DeliveryDecision | undefined; isMine: boolean; nameOf: (memberId: string) => string | undefined }) {
  const t = useTranslations('chats');
  if (!isMine || !decision) return null;
  const { agents_delivered: delivered, agents_not_delivered: notDelivered, humans_delivered: humans } = decision;
  if (notDelivered.length === 0) return null; // every agent of the room got it (or there is none): nothing to explain
  let text: string;
  if (delivered.length === 0) {
    text = humans > 0 ? t('deliveryDecisionPeopleOnly') : t('deliveryDecisionNoAgent');
  } else {
    const names = delivered.map((id) => nameOf(id)).filter((n): n is string => Boolean(n));
    const shown = names.slice(0, MAX_NAMES).map((n) => `@${n}`).join(' · ');
    const more = delivered.length - Math.min(names.length, MAX_NAMES);
    text = more > 0 && shown ? t('deliveryDecisionAgentsMore', { names: shown, n: more }) : shown ? t('deliveryDecisionAgents', { names: shown }) : t('deliveryDecisionAgentsUnnamed', { n: delivered.length });
  }
  return (
    <p data-testid="delivery-decision-line" className="mt-1 flex items-start justify-end gap-1 text-right text-xs text-muted-foreground break-keep">
      <ArrowRight aria-hidden="true" className="mt-1 size-3 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
